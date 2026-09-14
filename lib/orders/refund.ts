import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProviderByName } from "@/lib/payments";
import { ProviderRequestError } from "@/lib/payments/provider";
import { ApiError } from "@/lib/http/errors";
import { canTransition, type OrderStatus } from "@/lib/orders/stateMachine";
import { sendRefundConfirmationEmail } from "@/lib/email/notifications";

export interface InitiateRefundInput {
  paymentId: string;
  amountCents: number;
  reason: string;
  actorId: string;
}

export interface InitiateRefundResult {
  refundId: string;
  state: "processing" | "succeeded";
  paymentStatus?: "refunded" | "partially_refunded";
  orderStatus?: OrderStatus;
}

interface PreparedRefund {
  refundId: string;
  paymentId: string;
  paymentExternalId: string;
  providerPaymentId: string;
  provider: string;
  amountCents: number;
  currency: string;
  reason: string;
}

export interface RefundProviderEvidence {
  provider: string;
  amountCents: number;
  currency: string;
  paymentExternalId?: string;
  providerPaymentId?: string;
  providerRefundId?: string;
}

function assertRefundProviderEvidence(
  refund: { amount_cents: number; provider_refund_id: string | null },
  payment: { id: string; provider: string; provider_payment_id: string | null; currency: string },
  evidence?: RefundProviderEvidence,
): void {
  if (!evidence) return;
  const mismatch = evidence.provider !== payment.provider
    || evidence.amountCents !== refund.amount_cents
    || evidence.currency !== payment.currency
    || (evidence.paymentExternalId !== undefined && evidence.paymentExternalId !== payment.id)
    || (evidence.providerPaymentId !== undefined && evidence.providerPaymentId !== payment.provider_payment_id)
    || (evidence.providerRefundId !== undefined
      && refund.provider_refund_id !== null
      && evidence.providerRefundId !== refund.provider_refund_id);
  if (mismatch) {
    throw new ApiError(409, "REFUND_INTEGRITY_MISMATCH", "Provider refund evidence conflicts with stored payment/refund state");
  }
}

async function prepareRefund(input: InitiateRefundInput): Promise<PreparedRefund> {
  return prisma.$transaction(async (tx) => {
    const paymentRows = await tx.$queryRaw<
      { id: string; order_id: string; provider: string; provider_payment_id: string | null; amount_cents: number; currency: string; status: string }[]
    >`
      SELECT id, order_id, provider, provider_payment_id, amount_cents, currency, status
      FROM payments WHERE id = ${input.paymentId} FOR UPDATE
    `;
    const payment = paymentRows[0];
    if (!payment) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    if (payment.status !== "paid" && payment.status !== "partially_refunded") {
      throw new ApiError(409, "PAYMENT_NOT_REFUNDABLE", `Cannot refund a payment with status "${payment.status}"`);
    }
    if (!payment.provider_payment_id) {
      throw new ApiError(409, "PAYMENT_NOT_REFUNDABLE", "Payment has no provider reference to refund against");
    }

    const orderRows = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
      SELECT id, status FROM orders WHERE id = ${payment.order_id} FOR UPDATE
    `;
    const order = orderRows[0];
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found for this payment");

    const committedRefunds = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: { in: ["processing", "succeeded"] } },
      _sum: { amountCents: true },
    });
    const committedSoFar = committedRefunds._sum.amountCents ?? 0;
    const remaining = payment.amount_cents - committedSoFar;
    if (input.amountCents > remaining) {
      throw new ApiError(
        409,
        "REFUND_EXCEEDS_REMAINING",
        `Refund amount (${input.amountCents}) exceeds the remaining refundable balance (${remaining} cents)`,
      );
    }

    const isFullAgainstCommittedBalance = input.amountCents === remaining;
    const targetOrderStatus: OrderStatus = isFullAgainstCommittedBalance ? "refunded" : "partially_refunded";
    if (!canTransition(order.status, targetOrderStatus)) {
      throw new ApiError(
        409,
        "PARTIAL_REFUND_NOT_ALLOWED",
        `Order status "${order.status}" only allows a full refund, not a partial one`,
      );
    }

    const refund = await tx.refund.create({
      data: {
        paymentId: payment.id,
        amountCents: input.amountCents,
        reason: input.reason,
        status: "processing",
        initiatedByAdminUserId: input.actorId,
      },
    });
    await tx.auditLog.create({
      data: {
        actorType: "admin",
        actorId: input.actorId,
        action: "refund.requested",
        entityType: "refund",
        entityId: refund.id,
        metadata: { paymentId: payment.id, orderId: order.id, amountCents: input.amountCents, provider: payment.provider },
      },
    });

    return {
      refundId: refund.id,
      paymentId: payment.id,
      paymentExternalId: payment.id,
      providerPaymentId: payment.provider_payment_id,
      provider: payment.provider,
      amountCents: input.amountCents,
      currency: payment.currency,
      reason: input.reason,
    };
  });
}

export async function finalizeRefundSuccess(
  refundId: string,
  providerRefundId?: string | null,
  evidence?: RefundProviderEvidence,
): Promise<{ state: "succeeded"; paymentStatus: "refunded" | "partially_refunded"; orderStatus: OrderStatus; changed: boolean }> {
  const outcome = await prisma.$transaction(async (tx): Promise<{
    changed: boolean;
    paymentStatus: "refunded" | "partially_refunded";
    orderStatus: OrderStatus;
  }> => {
    const refundRows = await tx.$queryRaw<
      { id: string; payment_id: string; amount_cents: number; status: string; provider_refund_id: string | null }[]
    >`
      SELECT id, payment_id, amount_cents, status, provider_refund_id
      FROM refunds WHERE id = ${refundId} FOR UPDATE
    `;
    const refund = refundRows[0];
    if (!refund) throw new ApiError(404, "REFUND_NOT_FOUND", "Refund not found");

    const paymentRows = await tx.$queryRaw<
      { id: string; order_id: string; provider: string; provider_payment_id: string | null; amount_cents: number; currency: string; status: string }[]
    >`SELECT id, order_id, provider, provider_payment_id, amount_cents, currency, status FROM payments WHERE id = ${refund.payment_id} FOR UPDATE`;
    const payment = paymentRows[0];
    if (!payment) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    assertRefundProviderEvidence(refund, payment, evidence);
    const orderRows = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
      SELECT id, status FROM orders WHERE id = ${payment.order_id} FOR UPDATE
    `;
    const order = orderRows[0];
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found");

    if (refund.status === "succeeded") {
      return {
        changed: false,
        paymentStatus: payment.status as "refunded" | "partially_refunded",
        orderStatus: order.status,
      };
    }
    if (refund.status === "failed") {
      throw new ApiError(409, "REFUND_STATE_CONFLICT", "A failed refund cannot later be finalized as succeeded without reconciliation evidence");
    }

    const succeededOthers = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: "succeeded", id: { not: refund.id } },
      _sum: { amountCents: true },
    });
    const totalSucceeded = (succeededOthers._sum.amountCents ?? 0) + refund.amount_cents;
    if (totalSucceeded > payment.amount_cents) {
      throw new ApiError(409, "REFUND_INTEGRITY_ERROR", "Confirmed refunds exceed the original payment amount");
    }
    const fullyRefunded = totalSucceeded === payment.amount_cents;
    const paymentStatus: "refunded" | "partially_refunded" = fullyRefunded ? "refunded" : "partially_refunded";
    const orderStatus: OrderStatus = fullyRefunded ? "refunded" : "partially_refunded";
    if (!canTransition(order.status, orderStatus) && order.status !== orderStatus) {
      throw new ApiError(409, "REFUND_STATE_CONFLICT", `Cannot apply confirmed refund to order status "${order.status}"`);
    }

    const resolvedProviderRefundId = evidence?.providerRefundId ?? providerRefundId ?? refund.provider_refund_id;
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: "succeeded", providerRefundId: resolvedProviderRefundId },
    });
    await tx.payment.update({ where: { id: payment.id }, data: { status: paymentStatus } });
    await tx.order.update({ where: { id: order.id }, data: { status: orderStatus } });

    if (fullyRefunded) {
      const items = await tx.orderItem.findMany({
        where: { orderId: order.id },
        select: { id: true, ticketCategoryId: true },
      });
      for (const item of items) {
        // Used tickets remain used and never re-enter inventory. Only tickets
        // that are still valid are cancelled/released on a confirmed full refund.
        const cancelled = await tx.ticket.updateMany({
          where: { orderItemId: item.id, status: "valid" },
          data: { status: "cancelled" },
        });
        if (cancelled.count > 0) {
          await tx.$executeRaw`
            UPDATE inventory
            SET sold_quantity = sold_quantity - ${cancelled.count}
            WHERE ticket_category_id = ${item.ticketCategoryId}
              AND sold_quantity >= ${cancelled.count}
          `;
        }
      }
    }

    await tx.auditLog.create({
      data: {
        actorType: "system",
        action: "refund.succeeded",
        entityType: "refund",
        entityId: refund.id,
        metadata: {
          paymentId: payment.id,
          orderId: order.id,
          amountCents: refund.amount_cents,
          orderStatus,
          providerRefundId: resolvedProviderRefundId,
        },
      },
    });
    return { changed: true, paymentStatus, orderStatus };
  });

  // The finalizer is idempotent: exactly one transition has changed=true, so
  // retries/replayed webhooks cannot send duplicate confirmation emails.
  if (outcome.changed) await sendRefundConfirmationEmail(refundId);
  return { state: "succeeded", ...outcome };
}

export async function finalizeRefundFailure(
  refundId: string,
  providerRefundId?: string | null,
  evidence?: RefundProviderEvidence,
): Promise<{ changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; payment_id: string; amount_cents: number; status: string; provider_refund_id: string | null }[]>`
      SELECT id, payment_id, amount_cents, status, provider_refund_id FROM refunds WHERE id = ${refundId} FOR UPDATE
    `;
    const refund = rows[0];
    if (!refund) throw new ApiError(404, "REFUND_NOT_FOUND", "Refund not found");
    const paymentRows = await tx.$queryRaw<
      { id: string; provider: string; provider_payment_id: string | null; currency: string }[]
    >`SELECT id, provider, provider_payment_id, currency FROM payments WHERE id = ${refund.payment_id} FOR UPDATE`;
    const payment = paymentRows[0];
    if (!payment) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    assertRefundProviderEvidence(refund, payment, evidence);
    if (refund.status === "succeeded" || refund.status === "failed") return { changed: false };

    const resolvedProviderRefundId = evidence?.providerRefundId ?? providerRefundId ?? refund.provider_refund_id;
    await tx.refund.update({
      where: { id: refund.id },
      data: { status: "failed", providerRefundId: resolvedProviderRefundId },
    });
    await tx.auditLog.create({
      data: {
        actorType: "system",
        action: "refund.failed",
        entityType: "refund",
        entityId: refund.id,
        metadata: { providerRefundId: resolvedProviderRefundId },
      },
    });
    return { changed: true };
  });
}

async function submitPreparedRefund(prepared: PreparedRefund): Promise<InitiateRefundResult> {
  const provider = getPaymentProviderByName(prepared.provider);
  let result;
  try {
    result = await provider.refund({
      providerPaymentId: prepared.providerPaymentId,
      paymentExternalId: prepared.paymentExternalId,
      amountCents: prepared.amountCents,
      currency: prepared.currency,
      reason: prepared.reason,
      idempotencyKey: prepared.refundId,
    });
  } catch (error) {
    console.error(
      "provider.refund submission failed",
      error instanceof ProviderRequestError
        ? {
            name: error.name,
            status: error.status,
            outcomeUnknown: error.outcomeUnknown,
            retryAfterMs: error.retryAfterMs,
            correlationId: error.correlationId,
          }
        : { name: "unknown" },
    );

    const definitiveRejection =
      provider.name === "fake" ||
      (error instanceof ProviderRequestError && !error.outcomeUnknown);

    if (definitiveRejection) {
      await finalizeRefundFailure(prepared.refundId);
      throw new ApiError(502, "PROVIDER_REFUND_FAILED", "The payment provider rejected the refund");
    }

    await prisma.auditLog.create({
      data: {
        actorType: "system",
        action: "refund.submission_unknown",
        entityType: "refund",
        entityId: prepared.refundId,
        metadata: {
          provider: provider.name,
          providerStatus: error instanceof ProviderRequestError ? error.status : null,
          retryAfterMs: error instanceof ProviderRequestError ? error.retryAfterMs ?? null : null,
          correlationId: error instanceof ProviderRequestError ? error.correlationId ?? null : null,
        },
      },
    });
    throw new ApiError(
      502,
      "PROVIDER_REFUND_STATUS_UNKNOWN",
      "The provider did not confirm whether the refund request was accepted. It remains pending to prevent a duplicate refund.",
    );
  }

  if (result.providerRefundId) {
    await prisma.refund.update({ where: { id: prepared.refundId }, data: { providerRefundId: result.providerRefundId } });
  }
  if (result.state === "succeeded") {
    const finalized = await finalizeRefundSuccess(prepared.refundId, result.providerRefundId);
    return {
      refundId: prepared.refundId,
      state: "succeeded",
      paymentStatus: finalized.paymentStatus,
      orderStatus: finalized.orderStatus,
    };
  }

  await prisma.auditLog.create({
    data: {
      actorType: "system",
      action: "refund.submitted",
      entityType: "refund",
      entityId: prepared.refundId,
      metadata: { providerRefundId: result.providerRefundId, provider: prepared.provider },
    },
  });
  return { refundId: prepared.refundId, state: "processing" };
}

export async function initiateRefund(input: InitiateRefundInput): Promise<InitiateRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(400, "INVALID_AMOUNT", "Refund amount must be a positive number of cents");
  }
  return submitPreparedRefund(await prepareRefund(input));
}

const REFUND_RECONCILIATION_MIN_AGE_MS = 30_000;

/**
 * Reconciles asynchronous/ambiguous refunds without ever creating a new
 * business reference. A missing provider record is replayed with the exact
 * same Refund.id/refundReference, which ChariPay documents as idempotent.
 */
export async function reconcileProcessingRefunds(batchSize = 20): Promise<{
  checked: number;
  succeeded: number;
  failed: number;
  replayed: number;
  pending: number;
  errors: number;
}> {
  const cutoff = new Date(Date.now() - REFUND_RECONCILIATION_MIN_AGE_MS);
  const refunds = await prisma.refund.findMany({
    where: {
      status: "processing",
      createdAt: { lte: cutoff },
    },
    include: { payment: true },
    orderBy: { createdAt: "asc" },
    take: Math.max(1, Math.min(batchSize, 100)),
  });

  const stats = { checked: 0, succeeded: 0, failed: 0, replayed: 0, pending: 0, errors: 0 };
  for (const refund of refunds) {
    stats.checked += 1;
    let provider;
    try {
      provider = getPaymentProviderByName(refund.payment.provider);
    } catch (error) {
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

      // The lookup found no provider record. Replay the original intent using
      // the SAME Refund.id/reference; never mint a fresh refundReference.
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
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "refund.reconciliation_error",
          entityType: "refund",
          entityId: refund.id,
          metadata: {
            provider: provider.name,
            providerStatus: error instanceof ProviderRequestError ? error.status : null,
            retryAfterMs: error instanceof ProviderRequestError ? error.retryAfterMs ?? null : null,
            correlationId: error instanceof ProviderRequestError ? error.correlationId ?? null : null,
          },
        },
      });
    }
  }
  return stats;
}
