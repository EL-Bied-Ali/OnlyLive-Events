import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { confirmOrderPayment, failOrderPayment } from "@/lib/orders/fulfillment";
import { finalizeRefundFailure, finalizeRefundSuccess } from "@/lib/orders/refund";
import { sendOrderConfirmationEmail, sendPaymentFailedEmail } from "@/lib/email/notifications";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

type WebhookResult =
  | { kind: "duplicate" }
  | { kind: "integrity_mismatch"; code: string }
  | { kind: "event_collision" }
  | { kind: "processed"; outcome: string; orderId?: string; refundId?: string; paymentEventId?: string; providerRefundId?: string };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(",")}}`;
}

function consistentClaim(
  existing: { paymentId: string; eventType: string; signatureValid: boolean; rawPayload: unknown },
  paymentId: string,
  event: { type: string; raw: unknown },
): boolean {
  return existing.paymentId === paymentId
    && existing.eventType === event.type
    && existing.signatureValid !== false
    && canonicalJson(existing.rawPayload) === canonicalJson(event.raw);
}

async function auditIntegrityMismatch(
  action: string,
  paymentId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await prisma.auditLog.create({
    data: {
      actorType: "system",
      action,
      entityType: "Payment",
      entityId: paymentId,
      metadata,
    },
  });
}

export async function POST(request: NextRequest) {
  try {
    if ((process.env.PAYMENT_PROVIDER ?? "fake") !== "charipay") {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });

    const provider = getPaymentProvider();
    const event = await provider.parseWebhook({ rawBody, headers });
    if (!event.signatureValid) {
      return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
    }
    if (!event.payloadValid || event.amountCents === undefined) {
      return NextResponse.json({ error: "INVALID_PROVIDER_PAYLOAD" }, { status: 400 });
    }

    const isRefundEvent = event.type === "refund.succeeded" || event.type === "refund.failed";
    let refund = null as Awaited<ReturnType<typeof prisma.refund.findUnique>>;
    let payment = null as Awaited<ReturnType<typeof prisma.payment.findUnique>>;

    if (isRefundEvent) {
      if (!event.refundExternalId) {
        return NextResponse.json({ error: "REFUND_REFERENCE_MISSING" }, { status: 400 });
      }
      refund = await prisma.refund.findUnique({ where: { id: event.refundExternalId } });
      if (!refund) return NextResponse.json({ error: "REFUND_NOT_FOUND" }, { status: 404 });
      payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });
      if (!payment || payment.provider !== provider.name) {
        return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
      }

      const mismatch =
        event.amountCents !== refund.amountCents
        || payment.currency !== "MAD"
        || (event.currency !== undefined && event.currency !== payment.currency)
        || (event.paymentExternalId !== undefined && event.paymentExternalId !== payment.id)
        || (event.providerPaymentId !== undefined && payment.providerPaymentId !== event.providerPaymentId)
        || (event.providerRefundId !== undefined
          && refund.providerRefundId !== null
          && refund.providerRefundId !== event.providerRefundId);
      if (mismatch) {
        await auditIntegrityMismatch("refund.webhook_integrity_mismatch", payment.id, {
          refundId: refund.id,
          externalEventId: event.externalEventId,
          expectedAmountCents: refund.amountCents,
          receivedAmountCents: event.amountCents,
          expectedCurrency: payment.currency,
          receivedCurrency: event.currency ?? null,
        });
        return NextResponse.json({ error: "REFUND_INTEGRITY_MISMATCH" }, { status: 409 });
      }
    } else {
      payment = event.paymentExternalId
        ? await prisma.payment.findFirst({ where: { id: event.paymentExternalId, provider: provider.name } })
        : null;
      if (!payment && event.providerPaymentId) {
        payment = await prisma.payment.findUnique({
          where: { provider_providerPaymentId: { provider: provider.name, providerPaymentId: event.providerPaymentId } },
        });
      }
      if (!payment) return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });

      const mismatch =
        event.amountCents !== payment.amountCents
        || payment.currency !== "MAD"
        || (event.currency !== undefined && event.currency !== payment.currency)
        || (event.paymentExternalId !== undefined && event.paymentExternalId !== payment.id)
        || (event.providerPaymentId !== undefined && payment.providerPaymentId !== event.providerPaymentId);
      if (mismatch) {
        await auditIntegrityMismatch("payment.amount_mismatch", payment.id, {
          expectedAmountCents: payment.amountCents,
          expectedCurrency: payment.currency,
          receivedAmountCents: event.amountCents,
          receivedCurrency: event.currency ?? null,
          externalEventId: event.externalEventId,
        });
        return NextResponse.json({ error: "AMOUNT_MISMATCH" }, { status: 409 });
      }
    }

    const paymentId = payment.id;
    const result: WebhookResult = await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;

      const newEventId = crypto.randomUUID();
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
        VALUES (${newEventId}, ${paymentId}, ${provider.name}, ${event.externalEventId}, ${event.type}, ${JSON.stringify(event.raw)}::jsonb, true, now())
        ON CONFLICT (provider, external_event_id) DO NOTHING
        RETURNING id
      `;

      let paymentEventId: string;
      if (claimed.length > 0) {
        paymentEventId = claimed[0]!.id;
      } else {
        const existing = await tx.paymentEvent.findUniqueOrThrow({
          where: { provider_externalEventId: { provider: provider.name, externalEventId: event.externalEventId } },
        });
        if (!consistentClaim(existing, paymentId, event)) {
          await tx.auditLog.create({
            data: {
              actorType: "system",
              action: "payment.webhook_event_collision",
              entityType: "PaymentEvent",
              entityId: existing.id,
              metadata: { externalEventId: event.externalEventId, incomingEventType: event.type },
            },
          });
          return { kind: "event_collision" } as const;
        }
        if (existing.processedAt !== null) return { kind: "duplicate" } as const;
        paymentEventId = existing.id;
      }

      if (isRefundEvent) {
        // Finalization intentionally happens after this claim transaction. A
        // crash leaves processedAt=null, so a provider retry re-enters the
        // idempotent finalizer rather than losing the financial event.
        return {
          kind: "processed",
          outcome: event.type,
          refundId: refund!.id,
          paymentEventId,
          providerRefundId: event.providerRefundId,
        } as const;
      }

      let outcome: string;
      if (event.type === "payment.succeeded") {
        outcome = await confirmOrderPayment(payment.orderId, tx);
        if (outcome === "paid" || outcome === "paid_but_unfulfillable" || outcome === "reconciliation_required") {
          await tx.payment.update({ where: { id: payment.id }, data: { status: "paid" } });
        }
      } else if (event.type === "payment.failed") {
        outcome = await failOrderPayment(payment.orderId, "failed", tx);
        if (outcome === "failed") await tx.payment.update({ where: { id: payment.id }, data: { status: "failed" } });
      } else {
        outcome = "ignored";
      }

      await tx.paymentEvent.update({ where: { id: paymentEventId }, data: { processedAt: new Date() } });
      return { kind: "processed", outcome, orderId: payment.orderId } as const;
    });

    if (result.kind === "duplicate") return NextResponse.json({ ok: true, duplicate: true });
    if (result.kind === "integrity_mismatch") return NextResponse.json({ error: result.code }, { status: 409 });
    if (result.kind === "event_collision") return NextResponse.json({ error: "EVENT_COLLISION" }, { status: 409 });

    if (result.outcome === "refund.succeeded" && result.refundId && result.paymentEventId) {
      await finalizeRefundSuccess(result.refundId, result.providerRefundId);
      await prisma.paymentEvent.update({ where: { id: result.paymentEventId }, data: { processedAt: new Date() } });
    } else if (result.outcome === "refund.failed" && result.refundId && result.paymentEventId) {
      await finalizeRefundFailure(result.refundId, result.providerRefundId);
      await prisma.paymentEvent.update({ where: { id: result.paymentEventId }, data: { processedAt: new Date() } });
    } else if (result.outcome === "paid" && result.orderId) {
      await sendOrderConfirmationEmail(result.orderId);
    } else if ((result.outcome === "failed" || result.outcome === "cancelled") && result.orderId) {
      await sendPaymentFailedEmail(result.orderId);
    }

    return NextResponse.json({ ok: true, outcome: result.outcome });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
