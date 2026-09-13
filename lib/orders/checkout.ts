import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { extendHoldForCheckout } from "@/lib/inventory";
import { getPaymentProvider } from "@/lib/payments";
import { ApiError } from "@/lib/http/errors";

function generateOrderNumber(): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `OL-${timestamp}-${random}`;
}

export interface StartCheckoutResult {
  orderId: string;
  redirectUrl: string;
}

/**
 * Moves a hold into checkout: extends the hold's expiry (see
 * lib/inventory.ts), creates the Order/OrderItem/Payment rows, and asks
 * the configured PaymentProvider to start a payment. No money moves and
 * no ticket exists yet — that only happens once the provider's webhook
 * confirms payment (lib/orders/fulfillment.ts).
 */
export async function startCheckout(reservationId: string, userId: string, baseUrl: string): Promise<StartCheckoutResult> {
  const reservation = await extendHoldForCheckout(reservationId, userId);

  const [ticketCategory, user] = await Promise.all([
    prisma.ticketCategory.findUniqueOrThrow({
      where: { id: reservation.ticketCategoryId },
      select: { eventId: true },
    }),
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } }),
  ]);

  const totalAmountCents = reservation.quantity * reservation.unitPriceCents;

  const { order, payment } = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({
      data: {
        orderNumber: generateOrderNumber(),
        userId,
        eventId: ticketCategory.eventId,
        status: "pending_payment",
        totalAmountCents,
        expiresAt: reservation.expiresAt,
      },
    });

    await tx.reservation.update({ where: { id: reservation.id }, data: { orderId: order.id } });

    await tx.orderItem.create({
      data: {
        orderId: order.id,
        ticketCategoryId: reservation.ticketCategoryId,
        salesPhaseId: reservation.salesPhaseId,
        reservationId: reservation.id,
        quantity: reservation.quantity,
        unitPriceCents: reservation.unitPriceCents,
      },
    });

    const payment = await tx.payment.create({
      data: {
        orderId: order.id,
        provider: getPaymentProvider().name,
        status: "awaiting_payment",
        amountCents: totalAmountCents,
        idempotencyKey: crypto.randomUUID(),
      },
    });

    return { order, payment };
  });

  const provider = getPaymentProvider();
  const { redirectUrl, providerPaymentId } = await provider.createPayment({
    paymentId: payment.id,
    orderId: order.id,
    amountCents: payment.amountCents,
    currency: payment.currency,
    idempotencyKey: payment.idempotencyKey,
    customerEmail: user.email,
    returnUrl: `${baseUrl}/orders/${order.id}`,
  });

  await prisma.payment.update({ where: { id: payment.id }, data: { providerPaymentId } });

  return { orderId: order.id, redirectUrl };
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
