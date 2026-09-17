import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { CHECKOUT_EXTENSION_MS } from "@/lib/inventory";
import { getOnlyLivePublicUrl, getPaymentProvider, getPaymentProviderByName } from "@/lib/payments";
import { ProviderInputError, ProviderRequestError } from "@/lib/payments/provider";
import { ApiError } from "@/lib/http/errors";
import { failOrderPayment } from "@/lib/orders/fulfillment";
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
      const existingOrder = await tx.order.findUniqueOrThrow({
        where: { id: reservation.order_id },
        include: { payments: { orderBy: { createdAt: "asc" } } },
      });
      if (existingOrder.status !== "pending_payment") {
        throw new ApiError(409, "ORDER_NOT_PAYABLE", "This reservation's order is no longer payable");
      }
      const existingPayment = existingOrder.payments[0];
      if (!existingPayment) throw new ApiError(500, "PAYMENT_MISSING", "Order has no payment record");

      if (reservation.status !== "active") {
        throw new ApiError(409, "HOLD_EXPIRED", "This reservation is no longer active");
      }
      if (reservation.expires_at <= new Date()) {
        // Never resurface a possibly-payable provider URL after the local hold
        // deadline. Inventory remains reserved until provider reconciliation
        // proves the session terminal/non-payable.
        if (existingPayment.providerPaymentId) {
          throw new ApiError(
            409,
            "CHECKOUT_RECONCILIATION_REQUIRED",
            "This checkout expired locally and must be reconciled with the payment provider before it can be retried",
          );
        }
        throw new ApiError(409, "HOLD_EXPIRED", "This reservation has expired");
      }

      if (existingPayment.providerPaymentId && existingPayment.redirectUrl) {
        return { order: existingOrder, payment: existingPayment };
      }
      return { order: existingOrder, payment: existingPayment };
    }

    if (reservation.status !== "active" || reservation.expires_at <= new Date()) {
      throw new ApiError(409, "HOLD_EXPIRED", "This reservation has expired or is no longer active");
    }

    const newExpiresAt = new Date(Date.now() + CHECKOUT_EXTENSION_MS);
    await tx.$executeRaw`UPDATE reservations SET expires_at = ${newExpiresAt} WHERE id = ${reservationId}`;

    const [ticketCategory, phase] = await Promise.all([
      tx.ticketCategory.findUniqueOrThrow({ where: { id: reservation.ticket_category_id }, select: { eventId: true } }),
      tx.salesPhase.findUniqueOrThrow({ where: { id: reservation.sales_phase_id }, select: { currency: true } }),
    ]);
    const totalAmountCents = reservation.quantity * reservation.unit_price_cents;
    const provider = getPaymentProvider();

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
        provider: provider.name,
        status: "awaiting_payment",
        amountCents: totalAmountCents,
        currency: phase.currency,
        idempotencyKey: crypto.randomUUID(),
      },
    });
    return { order, payment };
  });
}

const PROVIDER_INIT_CLAIM_TIMEOUT_MS = 30_000;
const PROVIDER_INIT_POLL_INTERVAL_MS = 150;
const PROVIDER_INIT_POLL_ATTEMPTS = 15;
const PROVIDER_EXPIRY_GUARD_MS = 60_000;

async function claimAndInitializeProvider(
  order: Order,
  payment: Payment,
  userId: string,
  requestBaseUrl: string,
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
      await sleep(PROVIDER_INIT_POLL_INTERVAL_MS);
      current = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      continue;
    }

    try {
      // The Payment row is authoritative after creation. A default-provider
      // migration must never reroute an existing payment initialization retry.
      const provider = getPaymentProviderByName(payment.provider);
      const callbackBaseUrl = provider.name === "charipay" ? getOnlyLivePublicUrl() : requestBaseUrl;
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, name: true, phone: true } });
      const providerExpiresAt = order.expiresAt
        ? new Date(order.expiresAt.getTime() - PROVIDER_EXPIRY_GUARD_MS)
        : undefined;
      if (providerExpiresAt && providerExpiresAt <= new Date()) {
        throw new ApiError(409, "CHECKOUT_TOO_CLOSE_TO_EXPIRY", "Not enough time remains to start a safe provider checkout");
      }

      const created = await provider.createPayment({
        paymentId: payment.id,
        orderId: order.id,
        amountCents: payment.amountCents,
        currency: payment.currency,
        idempotencyKey: payment.idempotencyKey,
        customerEmail: user.email,
        customerName: user.name,
        customerPhone: user.phone,
        returnUrl: `${callbackBaseUrl}/orders/${order.id}`,
        expiresAt: providerExpiresAt,
      });

      const updated = await prisma.payment.update({
        where: { id: payment.id },
        data: { providerPaymentId: created.providerPaymentId, redirectUrl: created.redirectUrl, providerInitAt: null },
      });
      return { orderId: order.id, redirectUrl: updated.redirectUrl! };
    } catch (error) {
      console.error(
        "provider.createPayment failed",
        error instanceof ProviderRequestError
          ? { name: error.name, message: error.message, status: error.status, outcomeUnknown: error.outcomeUnknown, correlationId: error.correlationId }
          : error instanceof Error
            ? { name: error.name }
            : { name: "unknown" },
      );
      await prisma.payment.updateMany({
        where: { id: payment.id, providerPaymentId: null },
        data: { providerInitAt: null },
      });
      if (error instanceof ProviderRequestError && !error.outcomeUnknown) {
        await prisma.$transaction(async (tx) => {
          const paymentRows = await tx.$queryRaw<{ status: string; provider_payment_id: string | null }[]>`
            SELECT status, provider_payment_id FROM payments WHERE id = ${payment.id} FOR UPDATE
          `;
          const currentPayment = paymentRows[0];
          if (!currentPayment || currentPayment.provider_payment_id || (currentPayment.status !== "pending" && currentPayment.status !== "awaiting_payment")) return;
          const outcome = await failOrderPayment(order.id, "failed", tx);
          if (outcome === "failed") {
            await tx.payment.update({ where: { id: payment.id }, data: { status: "failed", providerInitAt: null } });
          }
        });
      }
      if (error instanceof ApiError) throw error;
      if (error instanceof ProviderInputError) {
        throw new ApiError(422, error.code, error.message);
      }
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

export async function startCheckout(reservationId: string, userId: string, requestBaseUrl: string): Promise<StartCheckoutResult> {
  const { order, payment } = await ensurePendingOrderAndPayment(reservationId, userId);
  return claimAndInitializeProvider(order, payment, userId, requestBaseUrl);
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
