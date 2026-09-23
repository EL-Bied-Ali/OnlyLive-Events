import { describe, expect, it, vi, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { createHold, sweepExpiredHolds } from "@/lib/inventory";
import { startCheckout } from "@/lib/orders/checkout";
import { FakeProvider } from "@/lib/payments/fakeProvider";
import { ProviderRequestError } from "@/lib/payments/provider";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

const BASE_URL = "http://localhost:3000";

async function createActiveHold() {
  const { category, phase } = await createTestCategory(5);
  const user = await createTestUser("checkout");
  const hold = await createHold({
    ticketCategoryId: category.id,
    salesPhaseId: phase.id,
    userId: user.id,
    quantity: 1,
  });
  return { user, category, phase, reservationId: hold.reservationId };
}

describe("checkout idempotency — one reservation produces at most one order", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a second sequential checkout request for the same reservation returns the existing order, not a new one", async () => {
    const { user, reservationId } = await createActiveHold();
    const first = await startCheckout(reservationId, user.id, BASE_URL);
    const second = await startCheckout(reservationId, user.id, BASE_URL);
    expect(second.orderId).toBe(first.orderId);
    expect(second.redirectUrl).toBe(first.redirectUrl);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: first.orderId } })).toBe(1);
  });

  it("concurrent checkout requests for the same reservation still produce exactly one order and call the provider exactly once", async () => {
    const { user, reservationId } = await createActiveHold();
    const createPaymentSpy = vi.spyOn(FakeProvider.prototype, "createPayment");
    const results = await Promise.all([
      startCheckout(reservationId, user.id, BASE_URL),
      startCheckout(reservationId, user.id, BASE_URL),
      startCheckout(reservationId, user.id, BASE_URL),
    ]);
    expect(new Set(results.map((r) => r.orderId)).size).toBe(1);
    expect(new Set(results.map((r) => r.redirectUrl)).size).toBe(1);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    expect(await prisma.orderItem.count({ where: { reservationId } })).toBe(1);
    expect(await prisma.payment.count({ where: { orderId: results[0]!.orderId } })).toBe(1);
    expect(createPaymentSpy).toHaveBeenCalledTimes(1);
  });

  it("recovers from a provider.createPayment failure without creating a duplicate order, and a retry succeeds", async () => {
    const { user, reservationId } = await createActiveHold();
    const createPaymentSpy = vi.spyOn(FakeProvider.prototype, "createPayment").mockRejectedValueOnce(new Error("simulated PSP network failure"));
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 502, code: "PROVIDER_UNAVAILABLE" });
    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("pending_payment");
    const paymentAfterFailure = await prisma.payment.findFirstOrThrow({ where: { orderId: orders[0]!.id } });
    expect(paymentAfterFailure.providerPaymentId).toBeNull();
    expect(paymentAfterFailure.redirectUrl).toBeNull();
    createPaymentSpy.mockRestore();
    const retry = await startCheckout(reservationId, user.id, BASE_URL);
    expect(retry.orderId).toBe(orders[0]!.id);
    expect(await prisma.order.count({ where: { userId: user.id } })).toBe(1);
    const paymentsAfterRetry = await prisma.payment.findMany({ where: { orderId: orders[0]!.id } });
    expect(paymentsAfterRetry).toHaveLength(1);
    expect(paymentsAfterRetry[0]!.redirectUrl).toBeTruthy();
  });

  it("releases inventory after a definitive provider rejection that created no payable session", async () => {
    const { user, category, reservationId } = await createActiveHold();
    const before = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    vi.spyOn(FakeProvider.prototype, "createPayment").mockRejectedValueOnce(
      new ProviderRequestError("invalid provider request", false, 400),
    );

    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_UNAVAILABLE",
    });

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const order = await prisma.order.findFirstOrThrow({ where: { userId: user.id } });
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const after = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(reservation.status).toBe("cancelled");
    expect(order.status).toBe("failed");
    expect(payment.status).toBe("failed");
    expect(after.reservedQuantity).toBe(before.reservedQuantity - 1);
  });

  it("does not auto-release an order-linked hold after a provider-init failure, but refuses a new checkout once its local deadline passed", async () => {
    const { user, category, reservationId } = await createActiveHold();
    const createPaymentSpy = vi.spyOn(FakeProvider.prototype, "createPayment").mockRejectedValueOnce(new Error("simulated PSP network failure"));
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 502, code: "PROVIDER_UNAVAILABLE" });
    createPaymentSpy.mockRestore();

    await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    await sweepExpiredHolds();

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(reservation.status).toBe("active");
    expect(reservation.orderId).not.toBeNull();
    expect(inventoryAfter.reservedQuantity).toBe(inventoryBefore.reservedQuantity);

    const retrySpy = vi.spyOn(FakeProvider.prototype, "createPayment");
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 409, code: "HOLD_EXPIRED" });
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("never reuses an already-created provider redirect after the local checkout deadline", async () => {
    const { user, category, reservationId } = await createActiveHold();
    const first = await startCheckout(reservationId, user.id, BASE_URL);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: first.orderId } });
    expect(payment.providerPaymentId).toBeTruthy();
    expect(payment.redirectUrl).toBe(first.redirectUrl);

    await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    await sweepExpiredHolds();
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventoryAfter.reservedQuantity).toBe(inventoryBefore.reservedQuantity);

    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 409,
      code: "CHECKOUT_RECONCILIATION_REQUIRED",
    });
    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.status).toBe("active");
  });

  it("refuses a brand-new provider payment after expiry even if the sweep hasn't run yet", async () => {
    const { user, reservationId } = await createActiveHold();
    const createPaymentSpy = vi.spyOn(FakeProvider.prototype, "createPayment").mockRejectedValueOnce(new Error("simulated PSP network failure"));
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 502 });
    createPaymentSpy.mockRestore();
    await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const stillActive = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(stillActive.status).toBe("active");
    const retrySpy = vi.spyOn(FakeProvider.prototype, "createPayment");
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 409, code: "HOLD_EXPIRED" });
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("refuses to check out a reservation that belongs to someone else", async () => {
    const { reservationId } = await createActiveHold();
    const attacker = await createTestUser("checkout-attacker");
    await expect(startCheckout(reservationId, attacker.id, BASE_URL)).rejects.toMatchObject({ status: 404 });
  });
});
