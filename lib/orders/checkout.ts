import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { CHECKOUT_EXTENSION_MS } from "@/lib/inventory";
import { getPaymentProvider } from "@/lib/payments";
import { ApiError } from "@/lib/http/errors";
import type { Order, Payment } from "@prisma/client";

function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `OL-${timestamp}-${random}`;
}

export interface StartCheckoutResult {
  orderId: string;
  redirectUrl: string;
}

interface ReservationRow {
  id: string;
  ticket_category_id: string;
  sales_phase_id: string;
  user_id: string;
  quantity: number;
  unit_price_cents: number;
  status: string;
  expires_at: Date;
  order_id: string | null;
}

/**
 * Ensures exactly one pending Order/Payment exists for this reservation,
 * creating one only if none exists yet. Idempotent under both sequential
 * and concurrent retries:
 *
 * - The reservation row is locked with `FOR UPDATE` first, so concurrent
 *   requests for the SAME reservation fully serialize — the second one
 *   only proceeds after the first has committed (and set
 *   reservations.order_id), at which point it takes the "already
 *   checked out" branch below instead of creating a second order.
 * - `order_items.reservation_id` also carries a database UNIQUE
 *   constraint as defense in depth: even if that serialization were
 *   somehow bypassed, a second INSERT for the same reservation would
 *   fail outright rather than silently creating a second fulfillment
 *   path for one hold.
 */
async function ensurePendingOrderAndPayment(
  reservationId: string,
  userId: string,
): Promise<{ order: Order; payment: Payment }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<ReservationRow[]>`
      SELECT id, ticket_category_id, sales_phase_id, user_id, quantity, unit_price_cents,
             status, expires_at, order_id
      FROM reservations WHERE id = ${reservationId} FOR UPDATE
    `;
    const reservation = rows[0];
    if (!reservation || reservation.user_id !== userId) {
      throw new ApiError(404, "RESERVATION_NOT_FOUND", "Reservation not found");
    }

    if (reservation.order_id) {
      // Checkout was already started for this hold (a prior call, or a
      // concurrent one that won the race for the row lock above) — never
      // create a second order for the same reservation.
      const existingOrder = await tx.order.findUniqueOrThrow({
        where: { id: reservation.order_id },
        include: { payments: { orderBy: { createdAt: "asc" } } },
      });
      if (existingOrder.status !== "pending_payment") {
        throw new ApiError(409, "ORDER_NOT_PAYABLE", "This reservation's order is no longer payable");
      }
      const existingPayment = existingOrder.payments[0];
      if (!existingPayment) {
        throw new ApiError(500, "PAYMENT_MISSING", "Order has no payment record");
      }
      return { order: existingOrder, payment: existingPayment };
    }

    if (reservation.status !== "active" || reservation.expires_at <= new Date()) {
      throw new ApiError(409, "HOLD_EXPIRED", "This reservation has expired or is no longer active");
    }

    const newExpiresAt = new Date(Date.now() + CHECKOUT_EXTENSION_MS);
    await tx.$executeRaw`
      UPDATE reservations SET expires_at = ${newExpiresAt} WHERE id = ${reservationId}
    `;

    const [ticketCategory, phase] = await Promise.all([
      tx.ticketCategory.findUniqueOrThrow({
        where: { id: reservation.ticket_category_id },
        select: { eventId: true },
      }),
      tx.salesPhase.findUniqueOrThrow({
        where: { id: reservation.sales_phase_id },
        select: { currency: true },
      }),
    ]);

    const totalAmountCents = reservation.quantity * reservation.unit_price_cents;

    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId,
        eventId: ticketCategory.eventId,
        status: "pending_payment",
        currency: phase.currency,
        totalAmountCents,
        expiresAt: newExpiresAt,
      },
    });

    await tx.reservation.update({ where: { id: reservationId }, data: { orderId: order.id } });

    // The `reservationId` unique constraint is what makes this INSERT
    // the actual concurrency-safety net described above.
    await tx.orderItem.create({
      data: {
        orderId: order.id,
        ticketCategoryId: reservation.ticket_category_id,
        salesPhaseId: reservation.sales_phase_id,
        reservationId: reservation.id,
        quantity: reservation.quantity,
        unitPriceCents: reservation.unit_price_cents,
      },
    });

    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        provider: getPaymentProvider().name,
        status: "awaiting_payment",
        amountCents: totalAmountCents,
        currency: phase.currency,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    return { order, payment };
  });
}

/**
 * Moves a hold into checkout. No money moves and no ticket exists yet —
 * that only happens once the provider's webhook confirms payment
 * (lib/orders/fulfillment.ts).
 *
 * Split into two phases on purpose: `ensurePendingOrderAndPayment` (pure
 * DB work, safe to retry) and the `provider.createPayment` call (external
 * I/O, must not run inside a held DB transaction). If the provider call
 * fails or times out, the Order/Payment already committed in phase one
 * are left exactly as they were (pending_payment / awaiting_payment, no
 * providerPaymentId yet) — the customer's next retry re-enters this same
 * function, takes the "already checked out" branch, sees no
 * `redirectUrl` stored yet, and safely retries ONLY the provider call
 * against the SAME payment. A second Order is never created for one
 * reservation, whether the failure was in our DB, the network, or the
 * provider itself.
 */
export async function startCheckout(reservationId: string, userId: string, baseUrl: string): Promise<StartCheckoutResult> {
  const { order, payment } = await ensurePendingOrderAndPayment(reservationId, userId);

  if (payment.redirectUrl && payment.providerPaymentId) {
    return { orderId: order.id, redirectUrl: payment.redirectUrl };
  }

  let created;
  try {
    const provider = getPaymentProvider();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    created = await provider.createPayment({
      paymentId: payment.id,
      orderId: order.id,
      amountCents: payment.amountCents,
      currency: payment.currency,
      idempotencyKey: payment.idempotencyKey,
      customerEmail: user.email,
      returnUrl: `${baseUrl}/orders/${order.id}`,
    });
  } catch (error) {
    console.error("provider.createPayment failed", error);
    throw new ApiError(
      502,
      "PROVIDER_UNAVAILABLE",
      "Could not start payment right now — the reservation is still held, please try again",
    );
  }

  await prisma.payment.update({
    where: { id: payment.id },
    data: { providerPaymentId: created.providerPaymentId, redirectUrl: created.redirectUrl },
  });

  return { orderId: order.id, redirectUrl: created.redirectUrl };
}

export async function getPaymentForFakeCheckoutPage(paymentId: string) {
  const payment = await prisma.payment.findUnique({
    where: { id: paymentId },
    include: { order: { include: { event: true } } },
  });
  if (!payment || payment.provider !== "fake") {
    throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
  }
  return payment;
}
