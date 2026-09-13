import { prisma } from "@/lib/db";
import { generateValidationToken } from "@/lib/tickets";

export type FulfillmentOutcome = "paid" | "paid_but_unfulfillable" | "already_handled" | "order_not_found";

/**
 * Applies a confirmed payment to an order. This is the only place tickets
 * are ever created, and it is only ever reached after the webhook has
 * verified the provider's signature and passed the PaymentEvent
 * idempotency check (see app/api/payments/webhook/fake/route.ts).
 *
 * The `UPDATE orders ... WHERE status = 'pending_payment'` below is both
 * the lock and the guard: if this event is a duplicate delivery (or a
 * second, differently-IDed event for the same logical payment), the
 * order is no longer `pending_payment` and this is a safe no-op.
 *
 * If the order's reservation already expired (and its stock may have been
 * resold to someone else) before this payment confirmation arrived, the
 * order becomes `paid_but_unfulfillable` instead of generating tickets
 * that would push sold_quantity past total_quantity.
 */
export async function confirmOrderPayment(orderId: string): Promise<FulfillmentOutcome> {
  return prisma.$transaction(async (tx) => {
    const orderRows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM orders WHERE id = ${orderId} FOR UPDATE
    `;
    const order = orderRows[0];
    if (!order) {
      return "order_not_found";
    }
    if (order.status !== "pending_payment") {
      return "already_handled";
    }

    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { id: true, ticketCategoryId: true, quantity: true, reservationId: true },
    });

    // Lock each reservation individually so its status can't flip
    // (e.g. via a concurrent sweep) between this check and our mutation.
    let allFulfillable = true;
    for (const item of items) {
      if (!item.reservationId) {
        allFulfillable = false;
        continue;
      }
      const rows = await tx.$queryRaw<{ id: string; status: string }[]>`
        SELECT id, status FROM reservations WHERE id = ${item.reservationId} FOR UPDATE
      `;
      const reservation = rows[0];
      if (!reservation || reservation.status !== "active") {
        allFulfillable = false;
      }
    }

    if (!allFulfillable) {
      await tx.order.update({ where: { id: orderId }, data: { status: "paid_but_unfulfillable" } });
      return "paid_but_unfulfillable";
    }

    const fullOrder = await tx.order.findUniqueOrThrow({ where: { id: orderId }, select: { eventId: true } });

    for (const item of items) {
      await tx.ticket.createMany({
        data: Array.from({ length: item.quantity }, () => ({
          orderItemId: item.id,
          eventId: fullOrder.eventId,
          ticketCategoryId: item.ticketCategoryId,
          validationToken: generateValidationToken(),
        })),
      });

      await tx.reservation.update({
        where: { id: item.reservationId! },
        data: { status: "converted" },
      });

      await tx.$executeRaw`
        UPDATE inventory
        SET reserved_quantity = reserved_quantity - ${item.quantity},
            sold_quantity = sold_quantity + ${item.quantity}
        WHERE ticket_category_id = ${item.ticketCategoryId}
      `;
    }

    await tx.order.update({ where: { id: orderId }, data: { status: "paid" } });
    return "paid";
  });
}

export type FailureOutcome = "failed" | "cancelled" | "already_handled" | "order_not_found";

/**
 * Applies a failed/cancelled payment outcome. Releases any still-active
 * reservation immediately (rather than waiting for expiry) since the
 * stock is definitely not going to be needed for this order.
 */
export async function failOrderPayment(
  orderId: string,
  targetStatus: "failed" | "cancelled",
): Promise<FailureOutcome> {
  return prisma.$transaction(async (tx) => {
    const orderRows = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM orders WHERE id = ${orderId} FOR UPDATE
    `;
    const order = orderRows[0];
    if (!order) {
      return "order_not_found";
    }
    if (order.status !== "pending_payment") {
      return "already_handled";
    }

    const items = await tx.orderItem.findMany({
      where: { orderId },
      select: { ticketCategoryId: true, quantity: true, reservationId: true },
    });

    for (const item of items) {
      if (!item.reservationId) continue;
      const updated = await tx.reservation.updateMany({
        where: { id: item.reservationId, status: "active" },
        data: { status: "cancelled" },
      });
      if (updated.count > 0) {
        await tx.$executeRaw`
          UPDATE inventory
          SET reserved_quantity = reserved_quantity - ${item.quantity}
          WHERE ticket_category_id = ${item.ticketCategoryId}
        `;
      }
    }

    await tx.order.update({ where: { id: orderId }, data: { status: targetStatus } });
    return targetStatus;
  });
}
