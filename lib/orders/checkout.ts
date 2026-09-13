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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
 *
 * On the "already checked out" branch, provider initialization is only
 * allowed to proceed (by the caller, afterward) if either (a) it already
 * completed — a stored redirect is always safe to hand back even if the
 * hold has since expired, since a real PSP session may already be open
 * for the customer — or (b) the reservation is still genuinely active
 * and unexpired right now. If initialization never completed AND the
 * hold has since expired (regardless of whether the background sweep
 * has flipped its status yet — expires_at in the past is checked
 * directly, the same lazy-expiry idiom used in lib/inventory.ts), this
 * throws HOLD_EXPIRED rather than letting the caller start a brand-new
 * provider payment for stock that may no longer be reserved.
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

      if (existingPayment.providerPaymentId && existingPayment.redirectUrl) {
        // Initialization already completed before any expiry — the
        // customer may already have a real PSP checkout session open;
        // always safe to hand the same redirect back.
        return { order: existingOrder, payment: existingPayment };
      }

      // Initialization never completed. Refuse to let the caller start
      // a brand-new provider payment once the hold has expired — stock
      // may no longer be reserved for it.
      if (reservation.status !== "active" || reservation.expires_at <= new Date()) {
        throw new ApiError(409, "HOLD_EXPIRED", "This reservation has expired or is no longer active");
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

/** How long a provider-initialization claim is honored before another
 * caller may assume the claimant crashed/timed out and reclaim it. */
const PROVIDER_INIT_CLAIM_TIMEOUT_MS = 30_000;
/** How long (and how often) a caller that lost the initialization race
 * waits for the winner to finish, before giving up. */
const PROVIDER_INIT_POLL_INTERVAL_MS = 150;
const PROVIDER_INIT_POLL_ATTEMPTS = 15; // ~2.25s worst case

/**
 * Ensures the payment provider is asked to create a payment exactly
 * once, even when several requests reach this function concurrently for
 * the same Payment (e.g. a double-click, or two tabs). ensurePendingOrder
 * AndPayment only prevents duplicate *database Orders* — this is the
 * separate guard against duplicate *provider calls*, since concurrent
 * callers could otherwise all see `redirectUrl: null` and all call
 * `provider.createPayment` at once.
 *
 * Mechanism: `payments.provider_init_at` is a durable claim. A caller
 * atomically claims it with a guarded UPDATE
 * (`provider_payment_id IS NULL AND (provider_init_at IS NULL OR stale)`)
 * — only the winner proceeds to call the provider; every other caller
 * polls briefly instead of calling it too. The claim and the provider
 * call are separate statements (no open DB transaction spans the
 * network I/O). If the winner crashes or times out, its claim goes
 * stale after PROVIDER_INIT_CLAIM_TIMEOUT_MS and a later caller can
 * reclaim it. `idempotencyKey` is generated once when the Payment row is
 * created and is never regenerated here, so every attempt (by any
 * claimant) presents the same key to the provider.
 */
async function claimAndInitializeProvider(
  order: Order,
  payment: Payment,
  userId: string,
  baseUrl: string,
): Promise<StartCheckoutResult> {
  let current = payment;

  for (let attempt = 0; attempt < PROVIDER_INIT_POLL_ATTEMPTS; attempt++) {
    if (current.providerPaymentId && current.redirectUrl) {
      return { orderId: order.id, redirectUrl: current.redirectUrl };
    }

    const claimed = await prisma.$queryRaw<{ id: string }[]>`
      UPDATE payments
      SET provider_init_at = now()
      WHERE id = ${payment.id}
        AND provider_payment_id IS NULL
        AND (provider_init_at IS NULL OR provider_init_at < now() - (${PROVIDER_INIT_CLAIM_TIMEOUT_MS} || ' milliseconds')::interval)
      RETURNING id
    `;

    if (claimed.length === 0) {
      // Someone else holds a fresh claim right now (or just finished —
      // the top of the next loop iteration will see it). Never call the
      // provider ourselves while that's true.
      await sleep(PROVIDER_INIT_POLL_INTERVAL_MS);
      current = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      continue;
    }

    // We won the claim: we are the only caller allowed to call the
    // provider for this payment right now.
    try {
      const provider = getPaymentProvider();
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
      const created = await provider.createPayment({
        paymentId: payment.id,
        orderId: order.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        idempotencyKey: payment.idempotencyKey,
        customerEmail: user.email,
        returnUrl: `${baseUrl}/orders/${order.id}`,
      });

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: created.providerPaymentId, redirectUrl: created.redirectUrl, providerInitAt: null },
      });
      return { orderId: order.id, redirectUrl: updated.redirectUrl! };
    } catch (error) {
      console.error("provider.createPayment failed", error);
      // Release the claim immediately (rather than waiting out the full
      // stale-claim window) so the very next retry — by this caller or
      // another — can attempt again right away.
      await prisma.payment.updateMany({
        where: { id: payment.id, providerPaymentId: null },
        data: { providerInitAt: null },
      });
      throw new ApiError(
        502,
        "PROVIDER_UNAVAILABLE",
        "Could not start payment right now — the reservation is still held, please try again",
      );
    }
  }

  throw new ApiError(
    503,
    "PROVIDER_INITIALIZATION_IN_PROGRESS",
    "Payment initialization is still in progress, please retry shortly",
  );
}

/**
 * Moves a hold into checkout. No money moves and no ticket exists yet —
 * that only happens once the provider's webhook confirms payment
 * (lib/orders/fulfillment.ts).
 *
 * Split into two phases on purpose: `ensurePendingOrderAndPayment` (pure
 * DB work, safe to retry) and `claimAndInitializeProvider` (external
 * I/O, protected by its own atomic claim so at most one caller performs
 * it at a time — see that function's doc comment). A second Order is
 * never created for one reservation, and the provider is never called
 * twice for one Payment, whether the failure/race was in our DB, the
 * network, or the provider itself.
 */
export async function startCheckout(reservationId: string, userId: string, baseUrl: string): Promise<StartCheckoutResult> {
  const { order, payment } = await ensurePendingOrderAndPayment(reservationId, userId);
  return claimAndInitializeProvider(order, payment, userId, baseUrl);
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
