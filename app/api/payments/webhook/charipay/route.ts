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
  | { kind: "amount_mismatch" }
  | { kind: "event_collision" }
  | { kind: "processed"; outcome: string; orderId?: string; refundId?: string; paymentEventId?: string };

function consistentClaim(
  existing: { paymentId: string; eventType: string; signatureValid: boolean; rawPayload: unknown },
  paymentId: string,
  event: { type: string; amountCents: number; currency: string },
): boolean {
  if (existing.paymentId !== paymentId || existing.eventType !== event.type || existing.signatureValid === false) return false;
  const raw = existing.rawPayload as { amount?: unknown; refundAmount?: unknown; currency?: unknown } | null;
  if (raw && typeof raw === "object") {
    const priorMajor = typeof raw.refundAmount === "number" ? raw.refundAmount : raw.amount;
    if (typeof priorMajor === "number" && Math.round(priorMajor * 100) !== event.amountCents) return false;
    if (typeof raw.currency === "string" && raw.currency !== event.currency) return false;
  }
  return true;
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

    let payment = event.paymentExternalId
      ? await prisma.payment.findFirst({ where: { id: event.paymentExternalId, provider: provider.name } })
      : null;
    let refund = null as Awaited<ReturnType<typeof prisma.refund.findUnique>>;

    if (event.type === "refund.succeeded" || event.type === "refund.failed") {
      if (!event.refundExternalId) {
        return NextResponse.json({ error: "REFUND_REFERENCE_MISSING" }, { status: 400 });
      }
      refund = await prisma.refund.findUnique({ where: { id: event.refundExternalId } });
      if (!refund) return NextResponse.json({ error: "REFUND_NOT_FOUND" }, { status: 404 });
      payment = await prisma.payment.findUnique({ where: { id: refund.paymentId } });
    } else if (!payment && event.providerPaymentId) {
      payment = await prisma.payment.findUnique({
        where: { provider_providerPaymentId: { provider: provider.name, providerPaymentId: event.providerPaymentId } },
      });
    }
    if (!payment) return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });

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
        if (existing.processedAt !== null) return { kind: "duplicate" } as const;
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
        paymentEventId = existing.id;
      }

      if (event.type === "refund.succeeded" || event.type === "refund.failed") {
        // Do NOT set processedAt yet. The refund finalizer runs after this
        // claim transaction commits. If the process crashes before/during
        // finalization, ChariPay's retry sees processedAt=null and safely
        // retries the idempotent finalizer instead of losing the event.
        return {
          kind: "processed",
          outcome: event.type,
          refundId: refund!.id,
          paymentEventId,
        } as const;
      }

      if (event.amountCents <= 0 || event.amountCents !== payment.amountCents || event.currency !== payment.currency) {
        await tx.auditLog.create({
          data: {
            actorType: "system",
            action: "payment.amount_mismatch",
            entityType: "Payment",
            entityId: payment.id,
            metadata: {
              expectedAmountCents: payment.amountCents,
              expectedCurrency: payment.currency,
              receivedAmountCents: event.amountCents,
              receivedCurrency: event.currency,
              externalEventId: event.externalEventId,
            },
          },
        });
        await tx.paymentEvent.update({ where: { id: paymentEventId }, data: { processedAt: new Date() } });
        return { kind: "amount_mismatch" } as const;
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
    if (result.kind === "amount_mismatch") return NextResponse.json({ error: "AMOUNT_MISMATCH" }, { status: 409 });
    if (result.kind === "event_collision") return NextResponse.json({ error: "EVENT_COLLISION" }, { status: 409 });

    if (result.outcome === "refund.succeeded" && result.refundId && result.paymentEventId) {
      await finalizeRefundSuccess(result.refundId);
      await prisma.paymentEvent.update({ where: { id: result.paymentEventId }, data: { processedAt: new Date() } });
    } else if (result.outcome === "refund.failed" && result.refundId && result.paymentEventId) {
      await finalizeRefundFailure(result.refundId);
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
