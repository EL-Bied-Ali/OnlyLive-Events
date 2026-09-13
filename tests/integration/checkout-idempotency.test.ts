import { describe, expect, it, vi, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { createHold } from "@/lib/inventory";
import { startCheckout } from "@/lib/orders/checkout";
import { FakeProvider } from "@/lib/payments/fakeProvider";
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

    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    const payments = await prisma.payment.findMany({ where: { orderId: first.orderId } });
    expect(payments).toHaveLength(1);
  });

  it("concurrent checkout requests for the same reservation still produce exactly one order and call the provider exactly once", async () => {
    const { user, reservationId } = await createActiveHold();
    const createPaymentSpy = vi.spyOn(FakeProvider.prototype, "createPayment");

    const results = await Promise.all([
      startCheckout(reservationId, user.id, BASE_URL),
      startCheckout(reservationId, user.id, BASE_URL),
      startCheckout(reservationId, user.id, BASE_URL),
    ]);

    const orderIds = new Set(results.map((r) => r.orderId));
    expect(orderIds.size).toBe(1);

    const redirectUrls = new Set(results.map((r) => r.redirectUrl));
    expect(redirectUrls.size).toBe(1); // every caller got back the SAME provider redirect

    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);

    const orderItems = await prisma.orderItem.findMany({ where: { reservationId } });
    expect(orderItems).toHaveLength(1); // the DB unique constraint's guarantee, not just app logic

    const payments = await prisma.payment.findMany({ where: { orderId: results[0]!.orderId } });
    expect(payments).toHaveLength(1);

    // The critical assertion: not merely "one database Order", but that
    // the external provider itself was only ever asked once, even though
    // three concurrent callers all raced past the "no redirectUrl yet"
    // check at roughly the same time.
    expect(createPaymentSpy).toHaveBeenCalledTimes(1);
  });

  it("recovers from a provider.createPayment failure without creating a duplicate order, and a retry succeeds", async () => {
    const { user, reservationId } = await createActiveHold();

    const createPaymentSpy = vi
      .spyOn(FakeProvider.prototype, "createPayment")
      .mockRejectedValueOnce(new Error("simulated PSP network failure"));

    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_UNAVAILABLE",
    });

    // The reservation must still be checked out against exactly one
    // Order/Payment — not rolled back, not duplicated.
    const orders = await prisma.order.findMany({ where: { userId: user.id } });
    expect(orders).toHaveLength(1);
    expect(orders[0]!.status).toBe("pending_payment");

    const paymentAfterFailure = await prisma.payment.findFirstOrThrow({ where: { orderId: orders[0]!.id } });
    expect(paymentAfterFailure.providerPaymentId).toBeNull();
    expect(paymentAfterFailure.redirectUrl).toBeNull();

    createPaymentSpy.mockRestore();

    const retry = await startCheckout(reservationId, user.id, BASE_URL);
    expect(retry.orderId).toBe(orders[0]!.id);

    const ordersAfterRetry = await prisma.order.findMany({ where: { userId: user.id } });
    expect(ordersAfterRetry).toHaveLength(1); // still exactly one order, never a second

    const paymentsAfterRetry = await prisma.payment.findMany({ where: { orderId: orders[0]!.id } });
    expect(paymentsAfterRetry).toHaveLength(1);
    expect(paymentsAfterRetry[0]!.redirectUrl).toBeTruthy();
  });

  it("refuses to start a brand-new provider payment once the hold has expired after a provider failure", async () => {
    const { user, reservationId } = await createActiveHold();

    const createPaymentSpy = vi
      .spyOn(FakeProvider.prototype, "createPayment")
      .mockRejectedValueOnce(new Error("simulated PSP network failure"));

    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 502,
      code: "PROVIDER_UNAVAILABLE",
    });
    expect(createPaymentSpy).toHaveBeenCalledTimes(1);
    createPaymentSpy.mockRestore();

    // Simulate the hold expiring and being swept before the customer
    // retries — initialization never completed, so the retry must not
    // start a brand-new provider payment for stock that may no longer
    // be reserved.
    await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const { sweepExpiredHolds } = await import("@/lib/inventory");
    await sweepExpiredHolds();

    const retrySpy = vi.spyOn(FakeProvider.prototype, "createPayment");
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 409,
      code: "HOLD_EXPIRED",
    });
    expect(retrySpy).not.toHaveBeenCalled();

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(reservation.status).toBe("expired");
  });

  it("refuses a brand-new provider payment after expiry even if the sweep hasn't run yet (lazy expiry check)", async () => {
    const { user, reservationId } = await createActiveHold();

    const createPaymentSpy = vi
      .spyOn(FakeProvider.prototype, "createPayment")
      .mockRejectedValueOnce(new Error("simulated PSP network failure"));
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({ status: 502 });
    createPaymentSpy.mockRestore();

    // Push the reservation's expiry into the past directly, WITHOUT
    // running the sweep — reservations.status is still 'active' in the
    // database at this point.
    await prisma.reservation.update({ where: { id: reservationId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const stillActive = await prisma.reservation.findUniqueOrThrow({ where: { id: reservationId } });
    expect(stillActive.status).toBe("active");

    const retrySpy = vi.spyOn(FakeProvider.prototype, "createPayment");
    await expect(startCheckout(reservationId, user.id, BASE_URL)).rejects.toMatchObject({
      status: 409,
      code: "HOLD_EXPIRED",
    });
    expect(retrySpy).not.toHaveBeenCalled();
  });

  it("refuses to check out a reservation that belongs to someone else", async () => {
    const { reservationId } = await createActiveHold();
    const attacker = await createTestUser("checkout-attacker");

    await expect(startCheckout(reservationId, attacker.id, BASE_URL)).rejects.toMatchObject({
      status: 404,
    });
  });
});
