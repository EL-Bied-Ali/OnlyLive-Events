import { generateValidationToken } from "@/lib/tickets";
import type { Prisma } from "@prisma/client";

export type FulfillmentOutcome =
  | "paid"
  | "paid_but_unfulfillable"
  | "reconciliation_required"
  | "already_handled"
  | "order_not_found";

/**
 * Applies a confirmed payment to an order. This is the only place tickets
 * are ever created, and it is only ever reached after the webhook has
 * verified the provider's signature, passed the PaymentEvent idempotency
 * check, and validated the paid amount/currency (see
 * app/api/payments/webhook/fake/route.ts).
 *
 * Takes an existing transaction client rather than opening its own —
 * claiming the webhook event, this fulfillment step, and the Payment
 * status update must all commit or roll back together (see the webhook
 * route for why: a failure partway through must not leave a PaymentEvent
 * row that later reads as "already processed" while nothing was actually
 * applied).
 *
 * The `UPDATE orders ... WHERE status = 'pending_payment'` below is both
 * the lock and the guard: if this event is a duplicate delivery (or a
 * second, differently-IDed event for the same logical payment), the
 * order is no longer `pending_payment` and this is a safe no-op — the
 * caller must not touch Payment.status when this returns
 * "already_handled" (see docs/PAYMENTS.md's event-transition policy).
 *
 * If the order's reservation already expired (and its stock may have been
 * resold to someone else) before this payment confirmation arrived, the
 * order becomes `paid_but_unfulfillable` instead of generating tickets
 * that would push sold_quantity past total_quantity.
 *
 * A payment.succeeded event can also arrive for an order that was
 * already marked `failed`/`cancelled` by an earlier, contradictory event
 * — the real PSP hasn't been chosen yet, so its actual event ordering
 * and idempotency guarantees are unknown; never assume this can't
 * happen and never silently drop evidence that money was captured. That
 * case is routed to `reconcileContradictorySuccess` below rather than
 * treated as `already_handled` (which would leave the order failed
 * despite a confirmed payment). See docs/PAYMENTS.md.
 */
export async function confirmOrderPayment(orderId: string, tx: Prisma.TransactionClient): Promise<FulfillmentOutcome> {
  const orderRows = await tx.$queryRaw<{ id: string; status: string }[]>`
    SELECT id, status FROM orders WHERE id = ${orderId} FOR UPDATE
  `;
  const order = orderRows[0];
  if (!order) {
    return "order_not_found";
  }
  if (order.status === "failed" || order.status === "cancelled") {
    return reconcileContradictorySuccess(orderId, order.status, tx);
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
}

/**
 * Handles a payment.succeeded event arriving for an order the app had
 * already settled as failed/cancelled — direct evidence that money was
 * captured despite that earlier (now contradicted) decision.
 *
 * IMPORTANT: the real payment provider has not been selected yet. This
 * function encodes a conservative stopgap policy, not that provider's
 * official event lifecycle — once a PSP is chosen, revisit this against
 * its actual documented guarantees (can a succeeded event really follow
 * a failed/cancelled one? is a later event authoritative? etc.) rather
 * than assuming this heuristic still applies. See docs/PAYMENTS.md.
 *
 * Policy: never oversell, never silently drop evidence of a captured
 * payment.
 * - If the original items' stock can still be safely fulfilled right
 *   now (checked atomically, same as createHold's category-lock
 *   pattern), tickets are generated directly against that stock and the
 *   order becomes `paid`. The original Reservation stays `cancelled` —
 *   it already was, accurately, at the time of the earlier failure —
 *   fulfillment here doesn't reuse it, it consumes fresh inventory.
 * - Otherwise the order becomes `reconciliation_required`: no ticket is
 *   generated, and a human must resolve it (fulfil manually if stock
 *   frees up, or refund). This is never re-attempted automatically.
 * Either way, an AuditLog entry is written, and the caller (the webhook
 * route) still sets Payment.status = "paid" — the payment itself did
 * succeed; that fact must never be hidden regardless of which Order
 * outcome follows.
 */
async function reconcileContradictorySuccess(
  orderId: string,
  previousStatus: "failed" | "cancelled",
  tx: Prisma.TransactionClient,
): Promise<FulfillmentOutcome> {
  const items = await tx.orderItem.findMany({
    where: { orderId },
    select: { id: true, ticketCategoryId: true, quantity: true },
  });

  const neededByCategory = new Map<string, number>();
  for (const item of items) {
    neededByCategory.set(item.ticketCategoryId, (neededByCategory.get(item.ticketCategoryId) ?? 0) + item.quantity);
  }

  // Lock every affected category's Inventory row, in a stable order, so
  // this can never deadlock against another transaction locking the
  // same set of categories (e.g. a concurrent createHold or a second
  // reconciliation) in a different order.
  const categoryIds = [...neededByCategory.keys()].sort();
  const availableByCategory = new Map<string, number>();
  for (const categoryId of categoryIds) {
    const rows = await tx.$queryRaw<{ total_quantity: number; reserved_quantity: number; sold_quantity: number }[]>`
      SELECT total_quantity, reserved_quantity, sold_quantity
      FROM inventory WHERE ticket_category_id = ${categoryId} FOR UPDATE
    `;
    const row = rows[0];
    availableByCategory.set(categoryId, row ? row.total_quantity - row.reserved_quantity - row.sold_quantity : 0);
  }

  let fulfillable = true;
  for (const [categoryId, needed] of neededByCategory) {
    if ((availableByCategory.get(categoryId) ?? 0) < needed) {
      fulfillable = false;
      break;
    }
  }

  if (!fulfillable) {
    await tx.order.update({ where: { id: orderId }, data: { status: "reconciliation_required" } });
    await tx.auditLog.create({
      data: {
        actorType: "system",
        action: "payment.contradictory_success_requires_reconciliation",
        entityType: "Order",
        entityId: orderId,
        metadata: { previousStatus, reason: "inventory_no_longer_available" },
      },
    });
    return "reconciliation_required";
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

    await tx.$executeRaw`
      UPDATE inventory
      SET sold_quantity = sold_quantity + ${item.quantity}
      WHERE ticket_category_id = ${item.ticketCategoryId}
    `;
  }

  await tx.order.update({ where: { id: orderId }, data: { status: "paid" } });
  await tx.auditLog.create({
    data: {
      actorType: "system",
      action: "payment.contradictory_success_reconciled_and_fulfilled",
      entityType: "Order",
      entityId: orderId,
      metadata: { previousStatus },
    },
  });

  return "paid";
}

export type FailureOutcome = "failed" | "cancelled" | "already_handled" | "order_not_found";

/**
 * Applies a failed/cancelled payment outcome. Releases any still-active
 * reservation immediately (rather than waiting for expiry) since the
 * stock is definitely not going to be needed for this order. Same
 * shared-transaction contract as confirmOrderPayment above.
 */
export async function failOrderPayment(
  orderId: string,
  targetStatus: "failed" | "cancelled",
  tx: Prisma.TransactionClient,
): Promise<FailureOutcome> {
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
}
