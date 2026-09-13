import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createHold, releaseHold } from "@/lib/inventory";
import { startCheckout } from "@/lib/orders/checkout";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

describe("hold cancellation is blocked once checkout has started", () => {
  it("refuses to release a reservation that already has an order/payment in flight", async () => {
    const { category, phase } = await createTestCategory(1);
    const user = await createTestUser("checkout-then-cancel");

    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: user.id,
      quantity: 1,
    });

    await startCheckout(hold.reservationId, user.id, "http://localhost:3000");

    await expect(releaseHold(hold.reservationId, user.id)).rejects.toMatchObject({
      status: 409,
      code: "CHECKOUT_IN_PROGRESS",
    });

    // The stock must still be reserved — not released while a payment
    // may still legitimately arrive.
    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(1);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe("active");
    expect(reservation.orderId).not.toBeNull();
  });

  it("still allows releasing a hold that has NOT yet moved into checkout", async () => {
    const { category, phase } = await createTestCategory(1);
    const user = await createTestUser("cancel-before-checkout");

    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: user.id,
      quantity: 1,
    });

    await releaseHold(hold.reservationId, user.id);

    const reservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(reservation.status).toBe("cancelled");

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(0);
  });
});
