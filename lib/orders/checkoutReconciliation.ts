import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProviderByName } from "@/lib/payments";
import { ProviderRequestError } from "@/lib/payments/provider";
import { failOrderPayment } from "@/lib/orders/fulfillment";

const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 50;
const DEFAULT_RETRY_DELAY_MS = 15 * 60 * 1000;

interface CheckoutCandidate {
  payment_id: string;
  order_id: string;
  provider: string;
  provider_payment_id: string | null;
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

/**
 * Claim a fair batch of expired, order-linked checkout payments. Updating
 * Payment.updatedAt is the durable lease/backoff cursor: concurrent workers
 * use SKIP LOCKED, and unresolved old rows rotate behind later work instead of
 * starving every newer checkout forever.
 */
async function claimExpiredCheckoutPayments(limit: number): Promise<CheckoutCandidate[]> {
  assertBatchSize(limit);
  return prisma.$transaction(async (tx) => tx.$queryRaw<CheckoutCandidate[]>`
    WITH due AS (
      SELECT p.id
      FROM payments p
      JOIN orders o ON o.id = p.order_id
      WHERE o.status = 'pending_payment'
        AND o.expires_at IS NOT NULL
        AND o.expires_at < now()
        AND p.status IN ('pending', 'awaiting_payment')
        AND p.updated_at <= now()
        AND EXISTS (
          SELECT 1 FROM reservations r
          WHERE r.order_id = o.id AND r.status = 'active'
        )
      ORDER BY p.updated_at ASC, p.created_at ASC
      FOR UPDATE OF p SKIP LOCKED
      LIMIT ${limit}
    )
    UPDATE payments p
    SET updated_at = now()
    FROM due
    WHERE p.id = due.id
    RETURNING p.id AS payment_id,
              p.order_id,
              p.provider,
              p.provider_payment_id
  `);
}

async function deferPayment(paymentId: string, retryAfterMs?: number): Promise<void> {
  const delay = Math.max(retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, 1_000);
  const next = new Date(Date.now() + delay);
  await prisma.$executeRaw`
    UPDATE payments SET updated_at = ${next}
    WHERE id = ${paymentId} AND status IN ('pending', 'awaiting_payment')
  `;
}

async function recordAttention(
  candidate: CheckoutCandidate,
  reason: string,
  metadata: Record<string, string | number | boolean | null | undefined> = {},
): Promise<void> {
  const existing = await prisma.auditLog.findFirst({
    where: {
      action: "payment.checkout_reconciliation_required",
      entityType: "Payment",
      entityId: candidate.payment_id,
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
      entityId: candidate.payment_id,
      metadata: {
        orderId: candidate.order_id,
        provider: candidate.provider,
        providerPaymentIdPresent: Boolean(candidate.provider_payment_id),
        reason,
        ...safeMetadata,
      },
    },
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
 * Local wall-clock expiry is never sufficient evidence to release inventory:
 * OnlyLive first asks the persisted provider to make the hosted session
 * non-payable. Only a definitive provider result permits local cancellation.
 * Everything ambiguous remains reserved and becomes visible for admin
 * attention rather than risking "captured money, resold ticket".
 */
export async function reconcileExpiredCheckouts(
  limit = DEFAULT_BATCH_SIZE,
): Promise<CheckoutReconciliationSummary> {
  const candidates = await claimExpiredCheckoutPayments(limit);
  const summary: CheckoutReconciliationSummary = {
    checked: candidates.length,
    closed: 0,
    unresolved: 0,
    errors: 0,
  };

  for (const candidate of candidates) {
    if (!candidate.provider_payment_id) {
      summary.unresolved += 1;
      await recordAttention(candidate, "provider_reference_missing_after_checkout_expiry");
      await deferPayment(candidate.payment_id);
      continue;
    }

    try {
      const provider = getPaymentProviderByName(candidate.provider);
      const result = await provider.closePaymentSession(
        candidate.provider_payment_id,
        `checkout-reconcile-${candidate.payment_id}`,
      );

      if (result.state === "non_payable") {
        if (await finalizeClosedCheckout(candidate)) summary.closed += 1;
        continue;
      }

      summary.unresolved += 1;
      await recordAttention(candidate, "provider_session_state_ambiguous", {
        providerStatus: result.providerStatus,
        correlationId: result.correlationId,
      });
      await deferPayment(candidate.payment_id, result.retryAfterMs);
    } catch (error) {
      summary.errors += 1;
      const providerError = error instanceof ProviderRequestError ? error : null;
      await recordAttention(candidate, "provider_reconciliation_request_failed", {
        status: providerError?.status,
        correlationId: providerError?.correlationId,
      });
      await deferPayment(candidate.payment_id, providerError?.retryAfterMs);
    }
  }

  return summary;
}
