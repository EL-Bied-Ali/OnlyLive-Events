import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProviderByName } from "@/lib/payments";
import { ProviderRequestError, type PaymentStatusLookupResult } from "@/lib/payments/provider";
import { confirmOrderPayment, failOrderPayment } from "@/lib/orders/fulfillment";
import {
  enqueueOrderConfirmationEmail,
  enqueueReconciliationAlertEmail,
} from "@/lib/email/notifications";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;
const CLAIM_LEASE_MS = 30_000;

interface CheckoutCandidate {
  payment_id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string | null;
  amount_cents: number;
  currency: string;
}

export interface CheckoutReconciliationSummary {
  checked: number;
  closed: number;
  unresolved: number;
  errors: number;
}

function assertBatchSize(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new Error(`Checkout reconciliation batch size must be between 1 and ${MAX_BATCH_SIZE}`);
  }
}

/** Identifies the Payment/Order pair a reconciliation attempt is acting on. */
export interface ReconcilablePayment {
  paymentId: string;
  orderId: string;
  provider: string;
  providerPaymentId?: string | null;
}

/**
 * Claim exactly one due checkout immediately before its provider work starts.
 * `updated_at` is the durable lease/backoff cursor. Moving it into the future
 * matters: a value of `now()` is already eligible for another worker as soon
 * as this short claim transaction commits, so SKIP LOCKED alone would not
 * protect the external provider call.
 *
 * Claiming one row at a time also avoids pre-leasing a large batch whose later
 * entries could sit idle while earlier provider requests consume most of the
 * lease window.
 *
 * `expires_at`/`updated_at` are naive `timestamp` columns populated with true
 * UTC digits (JS `Date`, including `leaseUntil` below) — comparing them
 * against a bare `now()` would implicitly cast that `timestamptz` through the
 * session's `TimeZone` GUC first, skewing both checks by that offset
 * whenever the server isn't UTC. Skewing the lease check specifically would
 * let a second worker reclaim a payment before its lease truly expired,
 * risking a duplicate provider reconciliation attempt.
 */
async function claimNextExpiredCheckoutPayment(): Promise<CheckoutCandidate | null> {
  const leaseUntil = new Date(Date.now() + CLAIM_LEASE_MS);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<CheckoutCandidate[]>`
      WITH due AS (
        SELECT p.id
        FROM payments p
        JOIN orders o ON o.id = p.order_id
        WHERE o.status = 'pending_payment'
          AND o.expires_at IS NOT NULL
          AND o.expires_at < (now() AT TIME ZONE 'UTC')
          AND p.status IN ('pending', 'awaiting_payment')
          AND p.updated_at <= (now() AT TIME ZONE 'UTC')
          AND EXISTS (
            SELECT 1 FROM reservations r
            WHERE r.order_id = o.id AND r.status = 'active'
          )
        ORDER BY p.updated_at ASC, p.created_at ASC
        FOR UPDATE OF p SKIP LOCKED
        LIMIT 1
      )
      UPDATE payments p
      SET updated_at = ${leaseUntil}
      FROM due
      WHERE p.id = due.id
      RETURNING p.id AS payment_id,
                p.order_id,
                p.provider,
                p.provider_payment_id,
                p.amount_cents,
                p.currency
    `;
    return rows[0] ?? null;
  });
}

function toReconcilablePayment(candidate: CheckoutCandidate): ReconcilablePayment {
  return {
    paymentId: candidate.payment_id,
    orderId: candidate.order_id,
    provider: candidate.provider,
    providerPaymentId: candidate.provider_payment_id,
  };
}

async function deferPayment(paymentId: string, retryAfterMs?: number): Promise<void> {
  const delay = Math.max(retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, 1_000);
  const next = new Date(Date.now() + delay);
  await prisma.$executeRaw`
    UPDATE payments SET updated_at = ${next}
    WHERE id = ${paymentId} AND status IN ('pending', 'awaiting_payment')
  `;
}

/**
 * Records (once per payment) that a reconciliation attempt — whether from
 * the expired-checkout batch worker or the customer-triggered on-demand
 * path below — hit an unresolved or failed provider lookup. Shared across
 * both callers so a given payment's stuck state surfaces to admins exactly
 * once regardless of which path noticed it first, instead of each caller
 * keeping its own audit trail (and instead of a poll interval spamming a
 * new row on every attempt).
 */
export async function recordPaymentReconciliationAttention(
  payment: ReconcilablePayment,
  reason: string,
  metadata: Record<string, string | number | boolean | null | undefined> = {},
): Promise<void> {
  const existing = await prisma.auditLog.findFirst({
    where: {
      action: "payment.checkout_reconciliation_required",
      entityType: "Payment",
      entityId: payment.paymentId,
    },
    select: { id: true },
  });
  if (existing) return;

  const safeMetadata = Object.fromEntries(
    Object.entries(metadata).filter(([, value]) => value !== undefined),
  ) as Record<string, string | number | boolean | null>;

  await prisma.auditLog.create({
    data: {
      actorType: "system",
      action: "payment.checkout_reconciliation_required",
      entityType: "Payment",
      entityId: payment.paymentId,
      metadata: {
        orderId: payment.orderId,
        provider: payment.provider,
        providerPaymentIdPresent: Boolean(payment.providerPaymentId),
        reason,
        ...safeMetadata,
      },
    },
  });
}

/**
 * Finalize authenticated provider-ledger evidence of a captured payment using
 * the same Payment -> Order lock order and fulfillment primitives as webhooks.
 * A concurrent signed webhook either wins first (making this a safe no-op) or
 * waits for this transaction, then observes the already-paid state.
 *
 * Shared by the expired-checkout batch worker below and by the
 * customer-triggered on-demand reconciliation path
 * (lib/orders/paymentReconciliation.ts) — both are just different ways of
 * *finding* a payment with confirmed ledger evidence; once found, applying
 * that evidence is the same operation and must go through the same
 * lock/idempotency guarantees, never a parallel implementation.
 */
export async function finalizeRecoveredPayment(
  payment: ReconcilablePayment,
  evidence: PaymentStatusLookupResult,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const paymentRows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM payments WHERE id = ${payment.paymentId} FOR UPDATE
    `;
    const current = paymentRows[0];
    if (!current || (current.status !== "pending" && current.status !== "awaiting_payment")) {
      return current?.status === "paid";
    }

    const outcome = await confirmOrderPayment(payment.orderId, tx);
    if (
      outcome !== "paid"
      && outcome !== "paid_but_unfulfillable"
      && outcome !== "reconciliation_required"
    ) {
      return false;
    }

    await tx.payment.update({
      where: { id: payment.paymentId },
      data: { status: "paid", providerInitAt: null },
    });

    if (outcome === "paid") {
      await enqueueOrderConfirmationEmail(tx, payment.orderId);
    } else {
      await enqueueReconciliationAlertEmail(tx, payment.orderId);
    }

    await tx.auditLog.create({
      data: {
        actorType: "system",
        action: "payment.reconciled_from_provider_transaction",
        entityType: "Payment",
        entityId: payment.paymentId,
        metadata: {
          orderId: payment.orderId,
          provider: payment.provider,
          providerOperationId: evidence.providerOperationId ?? null,
          providerStatus: evidence.providerStatus ?? null,
          outcome,
        },
      },
    });
    return true;
  });
}

/**
 * Final local transition after the provider has definitively made the hosted
 * session non-payable. The Payment row is locked before the Order transition,
 * matching webhook lock order. If a signed success webhook won the race first,
 * Payment.status is already `paid` and this becomes a no-op — inventory is
 * never released underneath a captured payment.
 */
async function finalizeClosedCheckout(candidate: CheckoutCandidate): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const paymentRows = await tx.$queryRaw<{ status: string }[]>`
      SELECT status FROM payments WHERE id = ${candidate.payment_id} FOR UPDATE
    `;
    const payment = paymentRows[0];
    if (!payment || (payment.status !== "pending" && payment.status !== "awaiting_payment")) {
      return false;
    }

    const outcome = await failOrderPayment(candidate.order_id, "cancelled", tx);
    if (outcome !== "cancelled") return false;

    await tx.payment.update({
      where: { id: candidate.payment_id },
      data: { status: "cancelled", providerInitAt: null },
    });
    await tx.auditLog.create({
      data: {
        actorType: "system",
        action: "payment.expired_checkout_closed",
        entityType: "Payment",
        entityId: candidate.payment_id,
        metadata: {
          orderId: candidate.order_id,
          provider: candidate.provider,
          reason: "provider_session_confirmed_non_payable",
        },
      },
    });
    return true;
  });
}

/**
 * Reconcile order-linked reservations whose local checkout deadline passed.
 * Local wall-clock expiry is never sufficient evidence to release inventory.
 * Providers with an authenticated ledger lookup are checked for captured money
 * first; a verified success is fulfilled locally. Only when success is ruled
 * out does OnlyLive ask the provider to make the hosted session non-payable.
 * A definitive close result is still required before local cancellation.
 * Everything ambiguous remains reserved for admin attention.
 */
export async function reconcileExpiredCheckouts(
  limit = DEFAULT_BATCH_SIZE,
): Promise<CheckoutReconciliationSummary> {
  assertBatchSize(limit);
  const summary: CheckoutReconciliationSummary = {
    checked: 0,
    closed: 0,
    unresolved: 0,
    errors: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const candidate = await claimNextExpiredCheckoutPayment();
    if (!candidate) break;
    summary.checked += 1;

    let provider: ReturnType<typeof getPaymentProviderByName>;
    try {
      provider = getPaymentProviderByName(candidate.provider);
    } catch {
      summary.errors += 1;
      await recordPaymentReconciliationAttention(toReconcilablePayment(candidate), "provider_reconciliation_configuration_failed");
      await deferPayment(candidate.payment_id);
      continue;
    }

    if (provider.lookupPaymentStatus) {
      try {
        const lookup = await provider.lookupPaymentStatus({
          orderExternalId: candidate.order_id,
          amountCents: candidate.amount_cents,
          currency: candidate.currency,
        });

        if (lookup.status === "succeeded") {
          if (await finalizeRecoveredPayment(toReconcilablePayment(candidate), lookup)) {
            continue;
          }

          summary.unresolved += 1;
          await recordPaymentReconciliationAttention(toReconcilablePayment(candidate), "provider_transaction_success_local_state_ambiguous", {
            providerStatus: lookup.providerStatus,
            providerOperationId: lookup.providerOperationId,
          });
          await deferPayment(candidate.payment_id);
          continue;
        }

        if (lookup.status === "pending" || lookup.status === "ambiguous") {
          summary.unresolved += 1;
          await recordPaymentReconciliationAttention(
            toReconcilablePayment(candidate),
            lookup.status === "pending"
              ? "provider_transaction_still_pending"
              : "provider_transaction_lookup_ambiguous",
            {
              providerStatus: lookup.providerStatus,
              providerOperationId: lookup.providerOperationId,
            },
          );
          await deferPayment(candidate.payment_id);
          continue;
        }
        // failed/cancelled/not_found are not enough on their own to release
        // inventory. Continue to the provider's explicit session-close proof.
      } catch (error) {
        summary.errors += 1;
        const providerError = error instanceof ProviderRequestError ? error : null;
        await recordPaymentReconciliationAttention(toReconcilablePayment(candidate), "provider_transaction_lookup_failed", {
          status: providerError?.status,
          correlationId: providerError?.correlationId,
        });
        await deferPayment(candidate.payment_id, providerError?.retryAfterMs);
        continue;
      }
    }

    if (!candidate.provider_payment_id) {
      summary.unresolved += 1;
      await recordPaymentReconciliationAttention(toReconcilablePayment(candidate), "provider_reference_missing_after_checkout_expiry");
      await deferPayment(candidate.payment_id);
      continue;
    }

    try {
      const result = await provider.closePaymentSession(
        candidate.provider_payment_id,
        `checkout-reconcile-${candidate.payment_id}`,
      );

      if (result.state === "non_payable") {
        if (await finalizeClosedCheckout(candidate)) summary.closed += 1;
        continue;
      }

      summary.unresolved += 1;
      await recordPaymentReconciliationAttention(toReconcilablePayment(candidate), "provider_session_state_ambiguous", {
        providerStatus: result.providerStatus,
        correlationId: result.correlationId,
      });
      await deferPayment(candidate.payment_id, result.retryAfterMs);
    } catch (error) {
      summary.errors += 1;
      const providerError = error instanceof ProviderRequestError ? error : null;
      await recordPaymentReconciliationAttention(toReconcilablePayment(candidate), "provider_reconciliation_request_failed", {
        status: providerError?.status,
        correlationId: providerError?.correlationId,
      });
      await deferPayment(candidate.payment_id, providerError?.retryAfterMs);
    }
  }

  return summary;
}
