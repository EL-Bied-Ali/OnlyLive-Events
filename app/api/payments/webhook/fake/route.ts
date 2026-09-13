import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getPaymentProvider, isFakePaymentsAllowed } from "@/lib/payments";
import { confirmOrderPayment, failOrderPayment } from "@/lib/orders/fulfillment";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

type WebhookResult =
  | { kind: "duplicate" }
  | { kind: "invalid_signature" }
  | { kind: "amount_mismatch" }
  | { kind: "event_collision" }
  | { kind: "processed"; outcome: string };

/**
 * Guards the reclaim path (an existing payment_events row with
 * processedAt still null): the SAME (provider, external_event_id) key
 * must not be reprocessed if the currently-resolved request disagrees
 * with what was originally claimed on any immutable fact. Concretely:
 *
 * - a different Payment (the providerPaymentId this request resolved to
 *   doesn't match what the claimed row recorded) — reprocessing would
 *   apply fulfillment to the wrong order/payment while the audit trail
 *   still points at the original one;
 * - a different event type (e.g. the first attempt was "failed" and a
 *   resend under the same event id now claims "succeeded") — that's a
 *   changed fact about history, not a legitimate retry;
 * - a different amount/currency than what the first attempt's raw
 *   payload recorded, for the same reason;
 * - the original attempt's signature was invalid — an event id that has
 *   already been seen with an invalid signature must never be "upgraded"
 *   to valid processing by a later attempt, signed or not; that would
 *   let a forgery attempt succeed by resending the same id with a
 *   corrected signature once the secret is guessed/leaked.
 *
 * Any of these is treated as a suspicious collision: rejected and
 * audited, never silently reprocessed, and the existing row's
 * rawPayload/signatureValid are left untouched so the historical record
 * of the anomaly isn't overwritten by whatever the new attempt claims.
 */
function isConsistentWithExistingClaim(
  existing: { paymentId: string; eventType: string; signatureValid: boolean; rawPayload: unknown },
  payment: { id: string },
  event: { type: string; amountCents: number; currency: string },
): boolean {
  if (existing.paymentId !== payment.id) return false;
  if (existing.eventType !== event.type) return false;
  if (existing.signatureValid === false) return false;

  const raw = existing.rawPayload as { amountCents?: unknown; currency?: unknown } | null;
  if (raw && typeof raw === "object") {
    if (raw.amountCents !== undefined && raw.amountCents !== event.amountCents) return false;
    if (raw.currency !== undefined && raw.currency !== event.currency) return false;
  }

  return true;
}

/**
 * The fake provider's simulated webhook callback. Deliberately exercises
 * the exact verification path a real PSP integration will reuse:
 * signature check -> amount/currency check -> idempotent claim ->
 * order-row-locked state transition -> ticket generation — all inside a
 * SINGLE database transaction. See docs/PAYMENTS.md for the full
 * event-transition policy this implements.
 *
 * Atomicity matters here specifically because "claim the event" (the
 * payment_events insert) and "apply it" (the order/payment state change)
 * must succeed or fail together. If they were separate transactions, a
 * crash between them would leave a claimed-but-unprocessed event that a
 * provider retry would see as `ON CONFLICT` and skip — silently losing
 * the payment confirmation. Wrapping both in one transaction means either
 * the whole thing commits (event marked processed, order/payment
 * updated) or none of it does (the claim itself rolls back, so a retry
 * genuinely reprocesses from scratch).
 */
export async function POST(request: NextRequest) {
  try {
    if (!isFakePaymentsAllowed()) {
      return NextResponse.json({ error: "NOT_FOUND" }, { status: 404 });
    }

    const rawBody = await request.text();
    const headers: Record<string, string> = {};
    request.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const provider = getPaymentProvider();
    const event = await provider.parseWebhook({ rawBody, headers });

    const payment = await prisma.payment.findUnique({
      where: { provider_providerPaymentId: { provider: provider.name, providerPaymentId: event.providerPaymentId } },
    });
    if (!payment) {
      return NextResponse.json({ error: "PAYMENT_NOT_FOUND" }, { status: 404 });
    }

    const result: WebhookResult = await prisma.$transaction(async (tx) => {
      // Lock the Payment row for the whole transaction. This is defense
      // in depth alongside the payment_events unique constraint and the
      // order-row lock inside confirmOrderPayment/failOrderPayment: it
      // fully serializes concurrent webhook deliveries for the SAME
      // payment even when they carry different event ids (e.g. a
      // "succeeded" and a "failed" event arriving at the same instant).
      await tx.$queryRaw`SELECT id FROM payments WHERE id = ${payment.id} FOR UPDATE`;

      // Claim (or reclaim) this event row inside the SAME transaction as
      // all processing below — see the function doc comment for why.
      const newEventId = crypto.randomUUID();
      const claimed = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
        VALUES (${newEventId}, ${payment.id}, ${provider.name}, ${event.externalEventId}, ${event.type}, ${JSON.stringify(event.raw)}::jsonb, ${event.signatureValid}, now())
        ON CONFLICT (provider, external_event_id) DO NOTHING
        RETURNING id
      `;

      let paymentEventId: string;
      if (claimed.length > 0) {
        paymentEventId = claimed[0]!.id;
      } else {
        // A row for this event id already exists. Only treat it as a
        // true duplicate if it was actually finished last time — a row
        // with processedAt still null means a prior attempt was
        // interrupted before reaching the end of this transaction, and
        // must be reprocessed rather than silently acknowledged.
        const existing = await tx.paymentEvent.findUniqueOrThrow({
          where: { provider_externalEventId: { provider: provider.name, externalEventId: event.externalEventId } },
        });
        if (existing.processedAt !== null) {
          return { kind: "duplicate" };
        }
        if (!isConsistentWithExistingClaim(existing, payment, event)) {
          await tx.auditLog.create({
            data: {
              actorType: "system",
              action: "payment.webhook_event_collision",
              entityType: "PaymentEvent",
              entityId: existing.id,
              metadata: {
                existingPaymentId: existing.paymentId,
                resolvedPaymentId: payment.id,
                existingEventType: existing.eventType,
                incomingEventType: event.type,
                existingSignatureValid: existing.signatureValid,
                incomingSignatureValid: event.signatureValid,
                externalEventId: event.externalEventId,
              },
            },
          });
          return { kind: "event_collision" };
        }
        paymentEventId = existing.id;
      }

      if (!event.signatureValid) {
        // Never mark processedAt for an unverified event — a corrected
        // resend with a valid signature (or a legitimate provider config
        // fix) must still be able to go through.
        return { kind: "invalid_signature" };
      }

      // Never trust the provider's stated amount/currency blindly — it
      // must match exactly what this Payment was created for.
      if (event.amountCents !== payment.amountCents || event.currency !== payment.currency) {
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
              eventType: event.type,
            },
          },
        });
        await tx.paymentEvent.update({ where: { id: paymentEventId }, data: { processedAt: new Date() } });
        return { kind: "amount_mismatch" };
      }

      // Payment/Order status transition policy (see docs/PAYMENTS.md):
      // Payment.status is only ever changed on a REAL transition applied
      // by confirmOrderPayment/failOrderPayment ("paid" / "failed" /
      // "cancelled" / "paid_but_unfulfillable" outcomes). An
      // "already_handled" or "order_not_found" outcome means some other
      // event already decided this order's fate — Payment.status is left
      // untouched so a late/conflicting event (succeeded-after-failed,
      // failed-after-succeeded, a duplicate event racing on a different
      // id, etc.) can never overwrite a settled payment.
      let outcome: string;
      switch (event.type) {
        case "payment.succeeded": {
          outcome = await confirmOrderPayment(payment.orderId, tx);
          // Money was captured for any of these three outcomes — the
          // difference between them is only whether/how the order could
          // be fulfilled, never whether the payment itself succeeded.
          if (outcome === "paid" || outcome === "paid_but_unfulfillable" || outcome === "reconciliation_required") {
            await tx.payment.update({ where: { id: payment.id }, data: { status: "paid" } });
          }
          break;
        }
        case "payment.failed": {
          outcome = await failOrderPayment(payment.orderId, "failed", tx);
          if (outcome === "failed") {
            await tx.payment.update({ where: { id: payment.id }, data: { status: "failed" } });
          }
          break;
        }
        case "payment.cancelled": {
          outcome = await failOrderPayment(payment.orderId, "cancelled", tx);
          if (outcome === "cancelled") {
            await tx.payment.update({ where: { id: payment.id }, data: { status: "cancelled" } });
          }
          break;
        }
        default:
          // refund.succeeded etc. — schema exists (Refund model) but the
          // refund flow itself is out of scope so far.
          outcome = "ignored";
      }

      await tx.paymentEvent.update({ where: { id: paymentEventId }, data: { processedAt: new Date() } });

      return { kind: "processed", outcome };
    });

    switch (result.kind) {
      case "duplicate":
        return NextResponse.json({ ok: true, duplicate: true });
      case "invalid_signature":
        return NextResponse.json({ error: "INVALID_SIGNATURE" }, { status: 401 });
      case "amount_mismatch":
        return NextResponse.json({ error: "AMOUNT_MISMATCH" }, { status: 409 });
      case "event_collision":
        return NextResponse.json({ error: "EVENT_COLLISION" }, { status: 409 });
      case "processed":
        return NextResponse.json({ ok: true, outcome: result.outcome });
    }
  } catch (error) {
    return apiErrorResponse(error);
  }
}
