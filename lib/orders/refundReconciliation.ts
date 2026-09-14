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
 * Atomically claims due refunds and rotates each claimed row to the back of
 * the queue. SKIP LOCKED lets concurrent workers take different batches.
 * Because every provider call is bounded by the adapter timeout, the 30s
 * claim window also acts as a short lease without adding another schema field.
 */
async function claimDueRefundIds(batchSize: number): Promise<string[]> {
  const limit = Math.max(1, Math.min(batchSize, MAX_BATCH_SIZE));
  const cutoff = new Date(Date.now() - MIN_RECONCILE_AGE_MS);
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      WITH candidates AS (
        SELECT id
        FROM refunds
        WHERE status = 'processing'
          AND updated_at <= ${cutoff}
        ORDER BY updated_at ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE refunds AS r
      SET updated_at = now()
      FROM candidates AS c
      WHERE r.id = c.id
      RETURNING r.id
    `;
    return rows.map((row) => row.id);
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
  const claimedIds = await claimDueRefundIds(batchSize);
  if (claimedIds.length === 0) {
    return { checked: 0, succeeded: 0, failed: 0, replayed: 0, pending: 0, errors: 0 };
  }

  const refunds = await prisma.refund.findMany({
    where: { id: { in: claimedIds }, status: "processing" },
    include: { payment: true },
  });
  const byId = new Map(refunds.map((refund) => [refund.id, refund]));
  const stats: RefundReconciliationStats = {
    checked: 0,
    succeeded: 0,
    failed: 0,
    replayed: 0,
    pending: 0,
    errors: 0,
  };

  for (const refundId of claimedIds) {
    const refund = byId.get(refundId);
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
            retryAfterMs: providerError?.retryAfterMs ?? null,
            correlationId: providerError?.correlationId ?? null,
          },
        },
      });
    }
  }

  return stats;
}
