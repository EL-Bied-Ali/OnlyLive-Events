import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
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
  status: "processing" | "succeeded";
  paymentStatus: "paid" | "partially_refunded" | "refunded";
  orderStatus: OrderStatus;
}

interface PreparedRefund {
  refundId: string;
  paymentId: string;
  provider: string;
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  reason: string;
  paymentStatus: "paid" | "partially_refunded";
  orderStatus: OrderStatus;
}

interface FinalizedRefund {
  refundId: string;
  paymentStatus: "partially_refunded" | "refunded";
  orderStatus: OrderStatus;
  changed: boolean;
}

/**
 * Finalizes provider-confirmed money movement. This is deliberately separate
 * from initiateRefund because real PSPs (including ChariPay) settle refunds
 * asynchronously. Tickets/stock and Payment/Order state move only here, once
 * the provider has definitively confirmed success.
 */
export async function finalizeRefundSuccess(
  refundId: string,
  providerRefundId?: string,
): Promise<FinalizedRefund> {
  const outcome = await prisma.$transaction(async (tx): Promise<FinalizedRefund> => {
    const refundRows = await tx.$queryRaw<
      { id: string; payment_id: string; amount_cents: number; status: string; provider_refund_id: string | null }[]
    >`
      SELECT id, payment_id, amount_cents, status, provider_refund_id
      FROM refunds WHERE id = ${refundId} FOR UPDATE
    `;
    const refund = refundRows[0];
    if (!refund) throw new ApiError(404, "REFUND_NOT_FOUND", "Refund not found");

    const paymentRows = await tx.$queryRaw<
      { id: string; order_id: string; amount_cents: number; status: string }[]
    >`
      SELECT id, order_id, amount_cents, status
      FROM payments WHERE id = ${refund.payment_id} FOR UPDATE
    `;
    const payment = paymentRows[0];
    if (!payment) throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");

    const orderRows = await tx.$queryRaw<{ id: string; status: OrderStatus }[]>`
      SELECT id, status FROM orders WHERE id = ${payment.order_id} FOR UPDATE
    `;
    const order = orderRows[0];
    if (!order) throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found for this payment");

    if (refund.status === "succeeded") {
      return {
        refundId: refund.id,
        paymentStatus: payment.status === "refunded" ? "refunded" : "partially_refunded",
        orderStatus: order.status,
        changed: false,
      };
    }

    // A provider success is authoritative money state. If a provider ever
    // sends failed then succeeded out of order, success wins; the inverse is
    // handled by markRefundFailed, which never downgrades succeeded.
    await tx.refund.update({
      where: { id: refund.id },
      data: {
        status: "succeeded",
        ...(providerRefundId ? { providerRefundId } : {}),
      },
    });

    const succeeded = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: "succeeded" },
      _sum: { amountCents: true },
    });
    const succeededTotal = succeeded._sum.amountCents ?? 0;
    if (succeededTotal > payment.amount_cents) {
      throw new ApiError(500, "REFUND_INVARIANT_BROKEN", "Succeeded refunds exceed the original payment amount");
    }

    const fullyRefunded = succeededTotal === payment.amount_cents;
    const targetPaymentStatus = fullyRefunded ? "refunded" : "partially_refunded";
    const targetOrderStatus: OrderStatus = fullyRefunded ? "refunded" : "partially_refunded";

    if (order.status !== targetOrderStatus && !canTransition(order.status, targetOrderStatus)) {
      throw new ApiError(
        409,
        "REFUND_STATE_CONFLICT",
        `Order status "${order.status}" cannot transition to "${targetOrderStatus}"`,
      );
    }

    await tx.payment.update({ where: { id: payment.id }, data: { status: targetPaymentStatus } });
    await tx.order.update({ where: { id: order.id }, data: { status: targetOrderStatus } });

    if (fullyRefunded) {
      // Only still-valid tickets release inventory. Used tickets consumed
      // their seat and must never be made resellable by a later refund.
      const items = await tx.orderItem.findMany({
        where: { orderId: order.id },
        select: { id: true, ticketCategoryId: true },
      });
      for (const item of items) {
        const cancelled = await tx.ticket.updateMany({
          where: { orderItemId: item.id, status: "valid" },
          data: { status: "cancelled" },
        });
        if (cancelled.count > 0) {
          await tx.$executeRaw`
            UPDATE inventory
            SET sold_quantity = sold_quantity - ${cancelled.count}
            WHERE ticket_category_id = ${item.ticketCategoryId}
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
          providerRefundId: providerRefundId ?? refund.provider_refund_id,
          orderStatus: targetOrderStatus,
        },
      },
    });

    return {
      refundId: refund.id,
      paymentStatus: targetPaymentStatus,
      orderStatus: targetOrderStatus,
      changed: true,
    };
  });

  if (outcome.changed) await sendRefundConfirmationEmail(outcome.refundId);
  return outcome;
}

/** Provider-confirmed failure frees the amount for a later admin retry. */
export async function markRefundFailed(refundId: string, providerRefundId?: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; payment_id: string; status: string }[]>`
      SELECT id, payment_id, status FROM refunds WHERE id = ${refundId} FOR UPDATE
    `;
    const refund = rows[0];
    if (!refund) throw new ApiError(404, "REFUND_NOT_FOUND", "Refund not found");
    if (refund.status === "succeeded" || refund.status === "failed") return;

    await tx.refund.update({
      where: { id: refund.id },
      data: { status: "failed", ...(providerRefundId ? { providerRefundId } : {}) },
    });
    await tx.auditLog.create({
      data: {
        actorType: "system",
        action: "refund.failed",
        entityType: "refund",
        entityId: refund.id,
        metadata: { paymentId: refund.payment_id, providerRefundId: providerRefundId ?? null },
      },
    });
  });
}

async function prepareRefund(input: InitiateRefundInput): Promise<PreparedRefund> {
  return prisma.$transaction(async (tx) => {
    const paymentRows = await tx.$queryRaw<
      {
        id: string;
        order_id: string;
        provider: string;
        provider_payment_id: string | null;
        amount_cents: number;
        currency: string;
        status: string;
      }[]
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

    // processing/pending refunds reserve refundable balance even before the
    // bank settles them. Otherwise two async requests could each appear to
    // fit and together exceed the original payment.
    const committed = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: { in: ["pending", "processing", "succeeded"] } },
      _sum: { amountCents: true },
    });
    const committedSoFar = committed._sum.amountCents ?? 0;
    const remaining = payment.amount_cents - committedSoFar;
    if (input.amountCents > remaining) {
      throw new ApiError(
        409,
        "REFUND_EXCEEDS_REMAINING",
        `Refund amount (${input.amountCents}) exceeds the remaining refundable balance (${remaining} cents)`,
      );
    }

    const wouldCompletePayment = committedSoFar + input.amountCents === payment.amount_cents;
    if (!wouldCompletePayment && !canTransition(order.status, "partially_refunded")) {
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
      provider: payment.provider,
      providerPaymentId: payment.provider_payment_id,
      amountCents: input.amountCents,
      currency: payment.currency,
      reason: input.reason,
      paymentStatus: payment.status as "paid" | "partially_refunded",
      orderStatus: order.status,
    };
  });
}

/**
 * Starts a refund without holding database locks across provider network I/O.
 * FakeProvider resolves synchronously; ChariPay returns processing and is
 * finalized only by its signed refund webhook.
 */
export async function initiateRefund(input: InitiateRefundInput): Promise<InitiateRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(400, "INVALID_AMOUNT", "Refund amount must be a positive number of cents");
  }

  const prepared = await prepareRefund(input);
  const provider = getPaymentProvider();
  if (provider.name !== prepared.provider) {
    // Never accidentally refund an old provider's payment through whichever
    // provider happens to be configured globally today.
    await markRefundFailed(prepared.refundId);
    throw new ApiError(409, "PAYMENT_PROVIDER_MISMATCH", "Payment belongs to a different payment provider");
  }

  let result;
  try {
    result = await provider.refund({
      paymentExternalId: prepared.paymentId,
      providerPaymentId: prepared.providerPaymentId,
      amountCents: prepared.amountCents,
      currency: prepared.currency,
      reason: prepared.reason,
      idempotencyKey: prepared.refundId,
    });
  } catch (error) {
    // For the in-process fake provider a thrown failure is definitive. For
    // a network PSP it is ambiguous: the provider may have accepted the
    // idempotent request before the connection died. Keep it processing so
    // the same refund reference can be reconciled/replayed safely rather
    // than issuing a new refund with a new reference.
    if (provider.name === "fake") {
      await markRefundFailed(prepared.refundId);
    } else {
      await prisma.auditLog.create({
        data: {
          actorType: "system",
          action: "refund.submission_uncertain",
          entityType: "refund",
          entityId: prepared.refundId,
          metadata: { error: error instanceof Error ? error.message : "unknown provider error" },
        },
      });
    }
    throw new ApiError(
      502,
      provider.name === "fake" ? "PROVIDER_REFUND_FAILED" : "PROVIDER_REFUND_STATUS_UNKNOWN",
      provider.name === "fake"
        ? "The payment provider rejected the refund"
        : "Refund submission status is unknown; do not create another refund until this reference is reconciled",
    );
  }

  await prisma.refund.update({
    where: { id: prepared.refundId },
    data: { providerRefundId: result.providerRefundId },
  });

  if (result.status === "failed") {
    await markRefundFailed(prepared.refundId, result.providerRefundId);
    throw new ApiError(502, "PROVIDER_REFUND_FAILED", "The payment provider rejected the refund");
  }

  if (result.status === "succeeded") {
    const finalized = await finalizeRefundSuccess(prepared.refundId, result.providerRefundId);
    return {
      refundId: finalized.refundId,
      status: "succeeded",
      paymentStatus: finalized.paymentStatus,
      orderStatus: finalized.orderStatus,
    };
  }

  return {
    refundId: prepared.refundId,
    status: "processing",
    paymentStatus: prepared.paymentStatus,
    orderStatus: prepared.orderStatus,
  };
}

export interface RefundReconciliationResult {
  checked: number;
  pending: number;
  succeeded: number;
  failed: number;
  replayedMissing: number;
  errors: number;
}

/**
 * Provider-status fallback for lost/delayed refund webhooks. Processing
 * refunds reserve refundable balance, so leaving them stuck forever is a
 * money-flow outage. The sweep checks old-enough rows in a bounded batch.
 *
 * If the provider cannot find our stable refundReference, the original POST
 * may have failed before ChariPay accepted it. Replaying the exact same POST
 * with the same Refund.id is safe because refundReference is ChariPay's
 * idempotency key: an accepted original is returned, a truly-missing one is
 * created once.
 */
export async function reconcileProcessingRefunds(batchSize = 20): Promise<RefundReconciliationResult> {
  const provider = getPaymentProvider();
  const cutoff = new Date(Date.now() - 30_000);
  const rows = await prisma.refund.findMany({
    where: {
      status: "processing",
      updatedAt: { lte: cutoff },
      payment: { provider: provider.name },
    },
    include: {
      payment: {
        select: { id: true, providerPaymentId: true, currency: true },
      },
    },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: Math.max(1, Math.min(batchSize, 100)),
  });

  const summary: RefundReconciliationResult = {
    checked: 0,
    pending: 0,
    succeeded: 0,
    failed: 0,
    replayedMissing: 0,
    errors: 0,
  };

  for (const refund of rows) {
    summary.checked += 1;
    try {
      let status = await provider.getRefundStatus(refund.providerRefundId ?? refund.id);

      if (status.status === "not_found") {
        if (!refund.payment.providerPaymentId) {
          throw new Error("Processing refund belongs to a payment without a provider reference");
        }
        summary.replayedMissing += 1;
        const replay = await provider.refund({
          paymentExternalId: refund.payment.id,
          providerPaymentId: refund.payment.providerPaymentId,
          amountCents: refund.amountCents,
          currency: refund.payment.currency,
          reason: refund.reason,
          idempotencyKey: refund.id,
        });
        await prisma.refund.update({
          where: { id: refund.id },
          data: { providerRefundId: replay.providerRefundId },
        });
        status = { providerRefundId: replay.providerRefundId, status: replay.status };
      }

      if (status.status === "succeeded") {
        await finalizeRefundSuccess(refund.id, status.providerRefundId);
        summary.succeeded += 1;
      } else if (status.status === "failed") {
        await markRefundFailed(refund.id, status.providerRefundId);
        summary.failed += 1;
      } else {
        summary.pending += 1;
      }
    } catch (error) {
      summary.errors += 1;
      console.error("Refund reconciliation failed", {
        refundId: refund.id,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  }

  return summary;
}
