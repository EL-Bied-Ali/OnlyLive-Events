import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it, vi, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload, FakeProvider } from "@/lib/payments/fakeProvider";
import { POST as webhookPost } from "@/app/api/payments/webhook/fake/route";
import { initiateRefund } from "@/lib/orders/refund";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function buildWebhookRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  return new NextRequest("http://localhost/api/payments/webhook/fake", {
    method: "POST",
    headers: { "content-type": "application/json", "x-onlylive-fake-signature": signFakeWebhookPayload(body) },
    body,
  });
}

/** Drives a fresh order through the real webhook path to a genuine "paid" state, tickets included. */
async function createPaidOrder(options: { quantity?: number; priceCents?: number } = {}) {
  const fixture = await createOrderAwaitingPayment(options);
  const payload = {
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type: "payment.succeeded" as const,
    amountCents: fixture.payment.amountCents,
    currency: fixture.payment.currency,
  };
  const response = await webhookPost(buildWebhookRequest(payload));
  expect(response.status).toBe(200);
  return fixture;
}

async function createAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `refund-admin-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: "Refund Admin",
      role: "admin",
    },
  });
}

describe("refund flow", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fully refunds a paid order: payment/order become refunded, valid tickets are cancelled, and stock is released", async () => {
    const fixture = await createPaidOrder({ quantity: 2, priceCents: 20_000 });
    const admin = await createAdmin();

    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });

    const result = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 40_000,
      reason: "Client cancellation",
      actorId: admin.id,
    });

    expect(result.paymentStatus).toBe("refunded");
    expect(result.orderStatus).toBe("refunded");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("refunded");
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("refunded");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(2);
    expect(tickets.every((t) => t.status === "cancelled")).toBe(true);

    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 2);

    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId: fixture.payment.id } });
    expect(refund.status).toBe("succeeded");
    expect(refund.providerRefundId).toBeTruthy();

    await expect(
      prisma.auditLog.findFirstOrThrow({ where: { entityType: "refund", entityId: refund.id, action: "refund.succeeded" } }),
    ).resolves.toBeTruthy();
  });

  it("partially refunds without cancelling tickets or touching inventory", async () => {
    const fixture = await createPaidOrder({ quantity: 1, priceCents: 30_000 });
    const admin = await createAdmin();
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });

    const result = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "Partial goodwill refund",
      actorId: admin.id,
    });

    expect(result.paymentStatus).toBe("partially_refunded");
    expect(result.orderStatus).toBe("partially_refunded");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets.every((t) => t.status === "valid")).toBe(true);

    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity);
  });

  it("a second partial refund that completes the balance transitions to fully refunded and then cancels tickets", async () => {
    const fixture = await createPaidOrder({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();

    const first = await initiateRefund({ paymentId: fixture.payment.id, amountCents: 4_000, reason: "part 1", actorId: admin.id });
    expect(first.paymentStatus).toBe("partially_refunded");

    const second = await initiateRefund({ paymentId: fixture.payment.id, amountCents: 6_000, reason: "part 2", actorId: admin.id });
    expect(second.paymentStatus).toBe("refunded");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets.every((t) => t.status === "cancelled")).toBe(true);
  });

  it("rejects a refund that exceeds the remaining refundable balance", async () => {
    const fixture = await createPaidOrder({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();

    await expect(
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 10_001, reason: "too much", actorId: admin.id }),
    ).rejects.toMatchObject({ status: 409, code: "REFUND_EXCEEDS_REMAINING" });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid");
  });

  it("rejects refunding a payment that was never paid", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const admin = await createAdmin();

    await expect(
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 1_000, reason: "n/a", actorId: admin.id }),
    ).rejects.toMatchObject({ status: 409, code: "PAYMENT_NOT_REFUNDABLE" });
  });

  it("rejects refunding an already-fully-refunded payment", async () => {
    const fixture = await createPaidOrder({ quantity: 1, priceCents: 5_000 });
    const admin = await createAdmin();
    await initiateRefund({ paymentId: fixture.payment.id, amountCents: 5_000, reason: "full", actorId: admin.id });

    await expect(
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 100, reason: "again", actorId: admin.id }),
    ).rejects.toMatchObject({ status: 409, code: "PAYMENT_NOT_REFUNDABLE" });
  });

  it("rejects a partial refund on an order with no fulfilled tickets (paid_but_unfulfillable)", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 10_000 });
    // Force the reservation to expire before the webhook arrives, exactly
    // as confirmOrderPayment's own unfulfillable path expects.
    await prisma.reservation.update({ where: { id: fixture.reservationId }, data: { status: "expired" } });
    const payload = {
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded" as const,
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
    };
    await webhookPost(buildWebhookRequest(payload));
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid_but_unfulfillable");

    const admin = await createAdmin();
    await expect(
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 5_000, reason: "partial", actorId: admin.id }),
    ).rejects.toMatchObject({ status: 409, code: "PARTIAL_REFUND_NOT_ALLOWED" });

    // A full refund is still legal from this state.
    const full = await initiateRefund({ paymentId: fixture.payment.id, amountCents: 10_000, reason: "full", actorId: admin.id });
    expect(full.orderStatus).toBe("refunded");
  });

  it("never cancels an already-used ticket or double-releases its stock", async () => {
    const fixture = await createPaidOrder({ quantity: 2, priceCents: 10_000 });
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderItemId: fixture.orderItem.id } });
    await prisma.ticket.update({ where: { id: ticket.id }, data: { status: "used", usedAt: new Date() } });
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });

    const admin = await createAdmin();
    await initiateRefund({ paymentId: fixture.payment.id, amountCents: 20_000, reason: "full", actorId: admin.id });

    const usedTicket = await prisma.ticket.findUniqueOrThrow({ where: { id: ticket.id } });
    expect(usedTicket.status).toBe("used");

    const otherTicket = await prisma.ticket.findFirstOrThrow({ where: { orderItemId: fixture.orderItem.id, id: { not: ticket.id } } });
    expect(otherTicket.status).toBe("cancelled");

    // Only the one still-valid ticket's stock is released, not both.
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 1);
  });

  it("propagates a provider refund failure without changing payment/order status, and audits it", async () => {
    const fixture = await createPaidOrder({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();
    vi.spyOn(FakeProvider.prototype, "refund").mockRejectedValueOnce(new Error("simulated PSP refund failure"));

    await expect(
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 10_000, reason: "will fail", actorId: admin.id }),
    ).rejects.toMatchObject({ status: 502, code: "PROVIDER_REFUND_FAILED" });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid");
    const refund = await prisma.refund.findFirstOrThrow({ where: { paymentId: fixture.payment.id } });
    expect(refund.status).toBe("failed");
    await expect(
      prisma.auditLog.findFirstOrThrow({ where: { entityType: "refund", entityId: refund.id, action: "refund.failed" } }),
    ).resolves.toBeTruthy();

    // A retry after the failure still succeeds and isn't blocked by the failed attempt.
    const retry = await initiateRefund({ paymentId: fixture.payment.id, amountCents: 10_000, reason: "retry", actorId: admin.id });
    expect(retry.paymentStatus).toBe("refunded");
  });

  it("serializes concurrent refund attempts on the same payment so the total never exceeds the paid amount", async () => {
    const fixture = await createPaidOrder({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();

    const results = await Promise.allSettled([
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 7_000, reason: "race A", actorId: admin.id }),
      initiateRefund({ paymentId: fixture.payment.id, amountCents: 7_000, reason: "race B", actorId: admin.id }),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);

    const refunds = await prisma.refund.findMany({ where: { paymentId: fixture.payment.id, status: "succeeded" } });
    const total = refunds.reduce((sum, r) => sum + r.amountCents, 0);
    expect(total).toBeLessThanOrEqual(10_000);
  });
});
