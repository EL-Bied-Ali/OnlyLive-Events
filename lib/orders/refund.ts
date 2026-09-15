import "server-only";
import { prisma } from "@/lib/db";
import { getPaymentProvider } from "@/lib/payments";
import { ApiError } from "@/lib/http/errors";
import { canTransition, type OrderStatus } from "@/lib/orders/stateMachine";
import { enqueueRefundConfirmationEmail } from "@/lib/email/notifications";

export interface InitiateRefundInput {
  paymentId: string;
  amountCents: number;
  reason: string;
  actorId: string;
}

export interface InitiateRefundResult {
  refundId: string;
  paymentStatus: "refunded" | "partially_refunded";
  orderStatus: OrderStatus;
}

type RefundOutcome =
  | { kind: "succeeded"; refundId: string; paymentStatus: "refunded" | "partially_refunded"; orderStatus: OrderStatus }
  | { kind: "failed"; refundId: string };

/**
 * Admin-initiated refund. The Payment/Order row lock is held for the
 * entire operation, provider call included — safe today because
 * FakeProvider.refund() is synchronous local work with no real network
 * I/O, and refunds are a low-frequency, human-driven action rather than
 * high-concurrency checkout traffic. A real PSP adapter's refund() is an
 * external HTTP call and holding a row lock across it would block other
 * work against that payment for the round-trip; if that becomes a
 * problem once a real provider is integrated, split this into
 * checkout.ts's claim-then-verify pattern instead. See docs/PAYMENTS.md's
 * Refunds section.
 *
 * The provider call is deliberately never allowed to `throw` out of the
 * transaction callback: doing so would roll back this function's own
 * bookkeeping (marking the Refund row "failed", writing the audit log)
 * along with everything else, silently discarding evidence of the
 * attempt. Failure is instead returned as a value and turned into an
 * ApiError only after the transaction has committed.
 */
export async function initiateRefund(input: InitiateRefundInput): Promise<InitiateRefundResult> {
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    throw new ApiError(400, "INVALID_AMOUNT", "Refund amount must be a positive number of cents");
  }

  const outcome = await prisma.$transaction(async (tx): Promise<RefundOutcome> => {
    const paymentRows = await tx.$queryRaw<
      { id: string; order_id: string; provider_payment_id: string | null; amount_cents: number; status: string }[]
    >`
      SELECT id, order_id, provider_payment_id, amount_cents, status
      FROM payments WHERE id = ${input.paymentId} FOR UPDATE
    `;
    const payment = paymentRows[0];
    if (!payment) {
      throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    }
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
    if (!order) {
      throw new ApiError(404, "ORDER_NOT_FOUND", "Order not found for this payment");
    }

    const alreadyRefunded = await tx.refund.aggregate({
      where: { paymentId: payment.id, status: "succeeded" },
      _sum: { amountCents: true },
    });
    const refundedSoFar = alreadyRefunded._sum.amountCents ?? 0;
    const remaining = payment.amount_cents - refundedSoFar;
    if (input.amountCents > remaining) {
      throw new ApiError(
        409,
        "REFUND_EXCEEDS_REMAINING",
        `Refund amount (${input.amountCents}) exceeds the remaining refundable balance (${remaining} cents)`,
      );
    }

    const isFullyRefunded = input.amountCents === remaining;
    const targetOrderStatus: OrderStatus = isFullyRefunded ? "refunded" : "partially_refunded";

    if (!canTransition(order.status, targetOrderStatus)) {
      // paid_but_unfulfillable / reconciliation_required orders have no
      // fulfilled tickets to partially retain — only a full refund is a
      // legal transition for them (see lib/orders/stateMachine.ts).
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

    let providerRefundId: string;
    try {
      const provider = getPaymentProvider();
      const result = await provider.refund({
        providerPaymentId: payment.provider_payment_id,
        amountCents: input.amountCents,
        reason: input.reason,
        idempotencyKey: refund.id,
      });
      providerRefundId = result.providerRefundId;
    } catch (error) {
      await tx.refund.update({ where: { id: refund.id }, data: { status: "failed" } });
      await tx.auditLog.create({
        data: {
          actorType: "admin",
          actorId: input.actorId,
          action: "refund.failed",
          entityType: "refund",
          entityId: refund.id,
          metadata: {
            paymentId: payment.id,
            amountCents: input.amountCents,
            error: error instanceof Error ? error.message : "unknown provider error",
          },
        },
      });
      return { kind: "failed", refundId: refund.id };
    }

    await tx.refund.update({
      where: { id: refund.id },
      data: { status: "succeeded", providerRefundId },
    });

    const newPaymentStatus = isFullyRefunded ? "refunded" : "partially_refunded";
    await tx.payment.update({ where: { id: payment.id }, data: { status: newPaymentStatus } });
    await tx.order.update({ where: { id: order.id }, data: { status: targetOrderStatus } });

    if (isFullyRefunded) {
      // Cancel every ticket still valid and release its stock for resale.
      // A ticket already used keeps its scan history untouched — the seat
      // was consumed and its slot is never resold regardless of refund.
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
        actorType: "admin",
        actorId: input.actorId,
        action: "refund.succeeded",
        entityType: "refund",
        entityId: refund.id,
        metadata: {
          paymentId: payment.id,
          orderId: order.id,
          amountCents: input.amountCents,
          orderStatus: targetOrderStatus,
        },
      },
    });

    // Enqueued in this same transaction, not sent after commit — see
    // lib/email/notifications.ts and lib/email/dispatcher.ts.
    await enqueueRefundConfirmationEmail(tx, refund.id);

    return { kind: "succeeded", refundId: refund.id, paymentStatus: newPaymentStatus, orderStatus: targetOrderStatus };
  });

  if (outcome.kind === "failed") {
    throw new ApiError(502, "PROVIDER_REFUND_FAILED", "The payment provider rejected the refund");
  }

  return { refundId: outcome.refundId, paymentStatus: outcome.paymentStatus, orderStatus: outcome.orderStatus };
}
