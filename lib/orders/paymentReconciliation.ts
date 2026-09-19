import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProviderByName } from "@/lib/payments";
import {
  finalizeRecoveredPayment,
  recordPaymentReconciliationAttention,
} from "@/lib/orders/checkoutReconciliation";

export interface OrderPaymentReconciliationResult {
  /** The order's status after this call — always the authoritative DB value. */
  status: string;
  /**
   * True when this call observed the payment as confirmed paid by the
   * provider ledger — either because it performed the pending -> paid
   * transition itself, or because a concurrent call/webhook already had by
   * the time this one reached the Payment row. Never true for anything
   * other than a confirmed paid outcome; callers that only care whether the
   * order just became payable should prefer comparing `status` instead.
   */
  reconciled: boolean;
}

/**
 * Customer-triggered counterpart to reconcileExpiredCheckouts: instead of
 * waiting for a checkout to expire before consulting the provider's
 * authenticated transaction ledger, this lets the order confirmation page
 * ask "is this already paid?" while the order is still fresh and a webhook
 * may simply be delayed. It reuses the exact same fulfillment primitive
 * (finalizeRecoveredPayment) so a success here produces the identical
 * Payment/Order/reservation/ticket/email outcome as a verified webhook —
 * there is no separate "customer-triggered fulfillment" code path.
 *
 * Every non-"succeeded" outcome (pending, ambiguous, failed, cancelled,
 * not_found, a lookup error, or no lookup support at all) is a deliberate
 * no-op: this function only ever moves a payment forward, never sideways
 * or backward. Inventory release and session cancellation stay exclusively
 * the batch worker's job once the checkout has actually expired — an
 * on-demand call arriving while the customer is still on the confirmation
 * page must never be the reason a reservation is released.
 */
export async function reconcileOrderPaymentOnDemand(orderId: string): Promise<OrderPaymentReconciliationResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true },
  });
  if (!order) {
    return { status: "not_found", reconciled: false };
  }

  // Already resolved one way or another (including paid_but_unfulfillable /
  // reconciliation_required, where Payment.status is already "paid") — an
  // idempotent no-op, matching requirement that repeat/late calls are harmless.
  if (order.status !== "pending_payment") {
    return { status: order.status, reconciled: false };
  }

  const payment = await prisma.payment.findFirst({
    where: { orderId, status: { in: ["pending", "awaiting_payment"] } },
    orderBy: { createdAt: "asc" },
    select: { id: true, provider: true, amountCents: true, currency: true },
  });
  if (!payment) {
    // No outstanding payment to check (should not normally happen while the
    // order is still pending_payment, but never guess — re-read live status).
    const fresh = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
    return { status: fresh.status, reconciled: false };
  }

  let provider: ReturnType<typeof getPaymentProviderByName>;
  try {
    provider = getPaymentProviderByName(payment.provider);
  } catch {
    // Configuration failure resolving the provider (e.g. missing env in this
    // deployment) — fail closed, leave the reservation untouched.
    return { status: order.status, reconciled: false };
  }

  if (!provider.lookupPaymentStatus) {
    // This provider has no authenticated ledger to consult on demand (e.g.
    // FakeProvider, whose "payment" is confirmed synchronously by its own
    // simulate action). Nothing to reconcile; the webhook path is unaffected.
    return { status: order.status, reconciled: false };
  }

  const reconcilable = { paymentId: payment.id, orderId, provider: payment.provider };

  try {
    const lookup = await provider.lookupPaymentStatus({
      orderExternalId: orderId,
      amountCents: payment.amountCents,
      currency: payment.currency,
    });

    if (lookup.status === "succeeded") {
      const finalized = await finalizeRecoveredPayment(reconcilable, lookup);
      const fresh = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { status: true } });
      if (!finalized) {
        // Payment/Order state moved in a way finalizeRecoveredPayment could
        // not safely fulfil from here (e.g. the reservation is gone) —
        // surface it for admin attention rather than silently dropping
        // provider-confirmed evidence of a captured payment.
        await recordPaymentReconciliationAttention(
          reconcilable,
          "customer_triggered_transaction_success_local_state_ambiguous",
          { providerStatus: lookup.providerStatus, providerOperationId: lookup.providerOperationId },
        );
      }
      return { status: fresh.status, reconciled: finalized };
    }

    // pending / ambiguous / failed / cancelled / not_found: none of these are
    // enough on their own to touch inventory or the payment session, and none
    // of them are admin-actionable on their own either. A payment sitting in
    // PENDING_3DS (or a single transient lookup hiccup) 5-30 seconds into an
    // active checkout is completely normal for this fast, frequent polling
    // path — recording it here would consume the shared, dedup-by-payment
    // "payment.checkout_reconciliation_required" audit slot (see
    // recordPaymentReconciliationAttention) and could silently suppress a
    // later, genuinely important reason (e.g. a confirmed success this same
    // function could not locally finalize, below). Only the
    // expired-checkout batch worker — which only ever looks at a payment
    // whose local deadline has actually passed — records these routine
    // ledger states; a poll arriving while the checkout is still fresh
    // never should. Expiry and cancellation stay exclusively that worker's
    // job, gated on the provider's explicit closePaymentSession proof.
    return { status: order.status, reconciled: false };
  } catch {
    // Provider lookup failure/timeout: fail closed and stay quiet. The
    // customer must not lose their reservation merely because this check
    // failed, and a single transient error during active polling is not an
    // admin-actionable event — see the comment above.
    return { status: order.status, reconciled: false };
  }
}
