import crypto from "node:crypto";
import { prisma } from "@/lib/db";

export async function createTestUser(prefix = "user") {
  return prisma.user.create({
    data: {
      email: `${prefix}-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: `Test ${prefix}`,
    },
  });
}

export async function createTestCategory(totalQuantity: number, priceCents = 10000) {
  const venue = await prisma.venue.create({
    data: { name: "Test Venue", addressLine1: "1 Test St", city: "Casablanca" },
  });

  const event = await prisma.event.create({
    data: {
      slug: `test-event-${crypto.randomUUID()}`,
      title: "Test Event",
      description: "Test event for automated tests",
      venueId: venue.id,
      startsAt: new Date(Date.now() + 30 * 86_400_000),
      salesOpenAt: new Date(Date.now() - 86_400_000),
      salesCloseAt: new Date(Date.now() + 30 * 86_400_000),
      status: "on_sale",
    },
  });

  const category = await prisma.ticketCategory.create({
    data: { eventId: event.id, name: "General" },
  });

  await prisma.inventory.create({
    data: { ticketCategoryId: category.id, totalQuantity },
  });

  const phase = await prisma.salesPhase.create({
    data: {
      ticketCategoryId: category.id,
      name: "Phase 1",
      priceCents,
      startsAt: new Date(Date.now() - 3_600_000),
      endsAt: null,
    },
  });

  return { venue, event, category, phase };
}

interface OrderFixtureOptions {
  quantity?: number;
  priceCents?: number;
}

/**
 * Creates a full pending_payment order (hold -> checkout state, minus the
 * actual HTTP calls) ready to be confirmed or failed by a simulated
 * webhook in tests.
 */
export async function createOrderAwaitingPayment(options: OrderFixtureOptions = {}) {
  const quantity = options.quantity ?? 1;
  const priceCents = options.priceCents ?? 10000;

  const { event, category, phase } = await createTestCategory(quantity, priceCents);
  const user = await createTestUser("payer");

  const { createHold } = await import("@/lib/inventory");
  const hold = await createHold({
    ticketCategoryId: category.id,
    salesPhaseId: phase.id,
    userId: user.id,
    quantity,
    unitPriceCents: priceCents,
  });

  const order = await prisma.order.create({
    data: {
      orderNumber: `TEST-${crypto.randomUUID()}`,
      userId: user.id,
      eventId: event.id,
      status: "pending_payment",
      totalAmountCents: quantity * priceCents,
    },
  });

  await prisma.reservation.update({ where: { id: hold.reservationId }, data: { orderId: order.id } });

  const orderItem = await prisma.orderItem.create({
    data: {
      orderId: order.id,
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      reservationId: hold.reservationId,
      quantity,
      unitPriceCents: priceCents,
    },
  });

  const payment = await prisma.payment.create({
    data: {
      orderId: order.id,
      provider: "fake",
      providerPaymentId: `fake_${crypto.randomUUID()}`,
      status: "awaiting_payment",
      amountCents: quantity * priceCents,
      idempotencyKey: crypto.randomUUID(),
    },
  });

  return { user, event, category, phase, order, orderItem, payment, reservationId: hold.reservationId };
}
