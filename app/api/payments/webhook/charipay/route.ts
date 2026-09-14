import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { confirmOrderPayment, failOrderPayment } from "@/lib/orders/fulfillment";
import { finalizeRefundSuccess, markRefundFailed } from "@/lib/orders/refund";
import { sendOrderConfirmationEmail, sendPaymentFailedEmail } from "@/lib/email/notifications";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import type { ParsedWebhookEvent } from "@/lib/payments/provider";

export const runtime = "nodejs";

type PaymentOutcome =
  | { kind: "duplicate" }
  | { kind: "processed"; outcome: string };

type ClaimedRefundEvent =
  | { kind: "duplicate" }
  | { kind: "claimed"; paymentEventId: string; refundId: string; providerRefundId: string };

function headersObject(request: NextRequest): Record<string, string> {
  const headers: Record<string, string> = {};
  request.headers.forEach((value, key) => { headers[key.toLowerCase()] = value; });
  return headers;
}

async function resolvePayment(event: ParsedWebhookEvent) {
  if (!event.paymentExternalId) {
    throw new ApiError(400, "INVALID_WEBHOOK_PAYLOAD", "ChariPay webhook is missing the OnlyLive externalId");
  }
  const payment = await prisma.payment.findUnique({ where: { id: event.paymentExternalId } });
  if (!payment || payment.provider !== "charipay") {
    throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
  }
  return payment;
}

async function resolveRefund(event: ParsedWebhookEvent) {
  if (!event.refundReference) {
    throw new ApiError(400, "INVALID_WEBHOOK_PAYLOAD", "ChariPay refund webhook is missing refundReference");
  }
  const refund = await prisma.refund.findUnique({
    where: { id: event.refundReference },
    include: { payment: true },
  });
  if (!refund || refund.payment.provider !== "charipay") {
    throw new ApiError(404, "REFUND_NOT_FOUND", "Refund not found");
  }
  if (event.paymentExternalId && event.paymentExternalId !== refund.paymentId) {
    throw new ApiError(409, "WEBHOOK_REFERENCE_MISMATCH", "Refund webhook references a different payment");
  }
  return refund;
}

async function insertEventClaim(
  paymentId: string,
  event: ParsedWebhookEvent,
): Promise<{ kind: "duplicate" } | { kind: "claimed"; paymentEventId: string }> {
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`;
    const eventRowId = crypto.randomUUID();
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO payment_events
        (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES
        (${eventRowId}, ${paymentId}, 'charipay', ${event.externalEventId}, ${event.type}, ${JSON.stringify(event.raw)}::jsonb, true, now())
      ON CONFLICT (provider, external_event_id) DO NOTHING
      RETURNING id
    `;
    if (claimed.length > 0) return { kind: "claimed", paymentEventId: claimed[0]!.id };

    const existing = await tx.paymentEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: "charipay", externalEventId: event.externalEventId } },
    });
    if (existing.processedAt !== null) return { kind: "duplicate" };
    if (existing.paymentId !== paymentId || existing.eventType !== event.type || existing.signatureValid !== true) {
      await tx.auditLog.create({
        data: {
          actorType: "system",
          action: "payment.webhook_event_collision",
          entityType: "PaymentEvent",
          entityId: existing.id,
          metadata: {
            provider: "charipay",
            existingPaymentId: existing.paymentId,
            resolvedPaymentId: paymentId,
            existingEventType: existing.eventType,
            incomingEventType: event.type,
            externalEventId: event.externalEventId,
          },
        },
      });
      throw new ApiError(409, "EVENT_COLLISION", "Webhook event id collision");
    }
    return { kind: "claimed", paymentEventId: existing.id };
  });
}

async function processPaymentEvent(event: ParsedWebhookEvent): Promise<PaymentOutcome> {
  const payment = await resolvePayment(event);
  if (event.amountCents !== payment.amountCents || event.currency !== payment.currency) {
    throw new ApiError(409, "AMOUNT_MISMATCH", "Webhook amount/currency does not match the payment");
  }

  return prisma.$transaction(async (tx): Promise<PaymentOutcome> => {
    await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id} FOR UPDATE`;

    const eventRowId = crypto.randomUUID();
    const claimed = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO payment_events
        (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES
        (${eventRowId}, ${payment.id}, 'charipay', ${event.externalEventId}, ${event.type}, ${JSON.stringify(event.raw)}::jsonb, true, now())
      ON CONFLICT (provider, external_event_id) DO NOTHING
      RETURNING id
    `;

    let paymentEventId: string;
    if (claimed.length > 0) {
      paymentEventId = claimed[0]!.id;
    } else {
      const existing = await tx.paymentEvent.findUniqueOrThrow({
        where: { provider_externalEventId: { provider: "charipay", externalEventId: event.externalEventId } },
      });
      if (existing.processedAt !== null) return { kind: "duplicate" };
      if (existing.paymentId !== payment.id || existing.eventType !== event.type || existing.signatureValid !== true) {
        throw new ApiError(409, "EVENT_COLLISION", "Webhook event id collision");
      }
      paymentEventId = existing.id;
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
      throw new ApiError(400, "UNSUPPORTED_EVENT", `Unsupported payment event ${event.type}`);
    }

    await tx.paymentEvent.update({ where: { id: paymentEventId }, data: { processedAt: new Date() } });
    return { kind: "processed", outcome };
  });
}

async function claimRefundEvent(event: ParsedWebhookEvent): Promise<ClaimedRefundEvent> {
  const refund = await resolveRefund(event);
  if (event.amountCents !== refund.amountCents || event.currency !== refund.payment.currency) {
    throw new ApiError(409, "AMOUNT_MISMATCH", "Webhook amount/currency does not match the refund");
  }
  const claim = await insertEventClaim(refund.paymentId, event);
  if (claim.kind === "duplicate") return claim;
  return {
    kind: "claimed",
    paymentEventId: claim.paymentEventId,
    refundId: refund.id,
    // refundReference is our stable Refund.id and is explicitly accepted by
    // ChariPay's refund lookup endpoint. Do not guess that an operationId or
    // checkout session id in a refund event is the provider's refund id.
    providerRefundId: refund.providerRefundId ?? refund.id,
  };
}

export async function POST(request: NextRequest) {
  try {
    const provider = getPaymentProvider();
    if (provider.name !== "charipay") return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });

    const rawBody = await request.text();
    const event = await provider.parseWebhook({ rawBody, headers: headersObject(request) });
    // ChariPay signs timestamp + '.' + the exact raw body. Never resolve or
    // mutate business state before this succeeds.
    if (!event.signatureValid) {
      return new NextResponse(null, { status: 401 });
    }

    if (event.type === "payment.succeeded" || event.type === "payment.failed") {
      const result = await processPaymentEvent(event);
      if (result.kind === "duplicate") return NextResponse.json({ ok: true, duplicate: true });
      const payment = await resolvePayment(event);
      if (result.outcome === "paid") await sendOrderConfirmationEmail(payment.orderId);
      else if (result.outcome === "failed") await sendPaymentFailedEmail(payment.orderId);
      return NextResponse.json({ ok: true, outcome: result.outcome });
    }

    if (event.type === "refund.succeeded" || event.type === "refund.failed") {
      const claim = await claimRefundEvent(event);
      if (claim.kind === "duplicate") return NextResponse.json({ ok: true, duplicate: true });

      // Refund business finalization is idempotent. We intentionally mark
      // PaymentEvent.processedAt only AFTER it succeeds; a crash in between
      // leaves processedAt null so the provider retry re-enters safely.
      if (event.type === "refund.succeeded") {
        await finalizeRefundSuccess(claim.refundId, claim.providerRefundId);
      } else {
        await markRefundFailed(claim.refundId, claim.providerRefundId);
      }
      await prisma.paymentEvent.update({ where: { id: claim.paymentEventId }, data: { processedAt: new Date() } });
      return NextResponse.json({ ok: true, outcome: event.type });
    }

    return NextResponse.json({ ok: true, ignored: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
