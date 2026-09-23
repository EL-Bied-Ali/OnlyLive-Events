import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProviderByName } from "@/lib/payments";
import { ProviderRequestError } from "@/lib/payments/provider";
import { finalizeRefundFailure, finalizeRefundSuccess } from "@/lib/orders/refund";

const MIN_RECONCILE_AGE_MS = 30_000;
const DEFAULT_BATCH_SIZE = 10;
const MAX_BATCH_SIZE = 20;

export interface RefundReconciliationStats {
  checked: number;
  succeeded: number;
  failed: number;
  replayed: number;
  pending: number;
  errors: number;
}

/**
 * Atomically claim one due refund and rotate only that row to the back of the
 * queue. Provider work is intentionally done before another row is claimed.
 * A batch can otherwise take much longer than the 30s eligibility window, so
 * pre-claiming the whole batch would let a second worker reclaim later rows
 * while the first worker was still processing earlier provider calls.
 *
 * SKIP LOCKED still lets concurrent workers take different refunds, while the
 * one-at-a-time claim keeps the short updated_at lease attached to work that is
 * actually about to start.
 *
 * `updated_at` is a naive `timestamp` column; the next claim cycle compares it
 * against a JS-computed cutoff (`new Date(Date.now() - MIN_RECONCILE_AGE_MS)`,
 * always true UTC). Writing a bare `now()` here would implicitly cast that
 * `timestamptz` into the session's `TimeZone` GUC, silently delaying every
 * refund's next eligible retry by that offset whenever the server isn't UTC.
 */
async function claimNextDueRefundId(): Promise<string | null> {
  const cutoff = new Date(Date.now() - MIN_RECONCILE_AGE_MS);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH candidate AS (
        SELECT id
        FROM refunds
        WHERE status = 'processing'
          AND updated_at <= ${cutoff}
        ORDER BY updated_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE refunds AS r
      SET updated_at = (now() AT TIME ZONE 'UTC')
      FROM candidate AS c
      WHERE r.id = c.id
      RETURNING r.id
    `;
    return rows[0]?.id ?? null;
  });
}

async function deferRefund(refundId: string, retryAfterMs?: number): Promise<void> {
  if (!retryAfterMs || retryAfterMs <= MIN_RECONCILE_AGE_MS) return;
  // Selection requires updated_at <= now - MIN_RECONCILE_AGE_MS. Moving the
  // row by (retryAfter - minAge) means it becomes due again after retryAfter.
  const updatedAt = new Date(Date.now() + retryAfterMs - MIN_RECONCILE_AGE_MS);
  await prisma.refund.updateMany({
    where: { id: refundId, status: "processing" },
    data: { updatedAt },
  });
}

export async function reconcileProcessingRefundsFair(
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<RefundReconciliationStats> {
  const limit = Math.max(1, Math.min(batchSize, MAX_BATCH_SIZE));
  const stats: RefundReconciliationStats = {
    checked: 0,
    succeeded: 0,
    failed: 0,
    replayed: 0,
    pending: 0,
    errors: 0,
  };

  for (let index = 0; index < limit; index += 1) {
    const refundId = await claimNextDueRefundId();
    if (!refundId) break;

    // A signed webhook may finalize the refund immediately after the claim.
    // In that race there is no provider work left for this worker to do.
    const refund = await prisma.refund.findFirst({
      where: { id: refundId, status: "processing" },
      include: { payment: true },
    });
    if (!refund) continue;
    stats.checked += 1;

    let provider;
    try {
      provider = getPaymentProviderByName(refund.payment.provider);
    } catch {
      stats.errors += 1;
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "refund.reconciliation_error",
          entityType: "refund",
          entityId: refund.id,
          metadata: { reason: "unsupported_persisted_provider", provider: refund.payment.provider },
        },
      });
      continue;
    }

    if (!refund.payment.providerPaymentId) {
      stats.errors += 1;
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "refund.reconciliation_error",
          entityType: "refund",
          entityId: refund.id,
          metadata: { reason: "missing_provider_payment_id", provider: provider.name },
        },
      });
      continue;
    }

    try {
      const reference = refund.providerRefundId ?? refund.id;
      const status = await provider.getRefundStatus(reference);
      if (status.status === "succeeded") {
        await finalizeRefundSuccess(refund.id, status.providerRefundId ?? refund.providerRefundId);
        stats.succeeded += 1;
        continue;
      }
      if (status.status === "failed") {
        await finalizeRefundFailure(refund.id, status.providerRefundId ?? refund.providerRefundId);
        stats.failed += 1;
        continue;
      }
      if (status.status === "pending") {
        if (status.providerRefundId && status.providerRefundId !== refund.providerRefundId) {
          await prisma.refund.updateMany({
            where: { id: refund.id, status: "processing" },
            data: { providerRefundId: status.providerRefundId },
          });
        }
        stats.pending += 1;
        continue;
      }

      // No provider record: replay the SAME refund reference. The provider's
      // idempotency contract prevents this from becoming a second refund.
      const replay = await provider.refund({
        providerPaymentId: refund.payment.providerPaymentId,
        paymentExternalId: refund.payment.id,
        orderExternalId: refund.payment.orderId,
        paymentAmountCents: refund.payment.amountCents,
        amountCents: refund.amountCents,
        currency: refund.payment.currency,
        reason: refund.reason,
        idempotencyKey: refund.id,
      });
      stats.replayed += 1;
      if (replay.providerRefundId) {
        await prisma.refund.updateMany({
          where: { id: refund.id, status: "processing" },
          data: { providerRefundId: replay.providerRefundId },
        });
      }
      if (replay.state === "succeeded") {
        await finalizeRefundSuccess(refund.id, replay.providerRefundId);
        stats.succeeded += 1;
      } else {
        stats.pending += 1;
      }
    } catch (error) {
      stats.errors += 1;
      const providerError = error instanceof ProviderRequestError ? error : null;
      await deferRefund(refund.id, providerError?.retryAfterMs);
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "refund.reconciliation_error",
          entityType: "refund",
          entityId: refund.id,
          metadata: {
            provider: provider.name,
            providerStatus: providerError?.status ?? null,
            providerCode: providerError?.providerCode ?? null,
            providerFieldHint: providerError?.providerFieldHint ?? null,
            retryAfterMs: providerError?.retryAfterMs ?? null,
            correlationId: providerError?.correlationId ?? null,
          },
        },
      });
    }
  }

  return stats;
}
