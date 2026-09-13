import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createHold, sweepExpiredHolds } from "@/lib/inventory";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

describe("inventory concurrency — the oversell-prevention critical section", () => {
  it("lets exactly one of two concurrent buyers win the last ticket", async () => {
    const { category, phase } = await createTestCategory(1);
    const [buyerA, buyerB] = await Promise.all([createTestUser("a"), createTestUser("b")]);

    const results = await Promise.allSettled([
      createHold({
        ticketCategoryId: category.id,
        salesPhaseId: phase.id,
        userId: buyerA.id,
        quantity: 1,
      }),
      createHold({
        ticketCategoryId: category.id,
        salesPhaseId: phase.id,
        userId: buyerB.id,
        quantity: 1,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === "rejected") {
      expect(rejected[0].reason).toMatchObject({ code: "SOLD_OUT" });
    }

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity + inventory.soldQuantity).toBe(1);
  });

  it("rejects exactly one buyer when N buyers race for N-1 tickets", async () => {
    const buyerCount = 5;
    const { category, phase } = await createTestCategory(buyerCount - 1);
    const buyers = await Promise.all(
      Array.from({ length: buyerCount }, (_, i) => createTestUser(`race-${i}`)),
    );

    const results = await Promise.allSettled(
      buyers.map((buyer) =>
        createHold({
          ticketCategoryId: category.id,
          salesPhaseId: phase.id,
          userId: buyer.id,
          quantity: 1,
        }),
      ),
    );

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(buyerCount - 1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity + inventory.soldQuantity).toBe(buyerCount - 1);
  });

  it("reclaims an expired hold's stock for the next buyer (lazy release)", async () => {
    const { category, phase } = await createTestCategory(1);
    const [buyerA, buyerB] = await Promise.all([createTestUser("expire-a"), createTestUser("expire-b")]);

    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: buyerA.id,
      quantity: 1,
    });

    await prisma.reservation.update({
      where: { id: hold.reservationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const secondHold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: buyerB.id,
      quantity: 1,
    });
    expect(secondHold.reservationId).toBeTruthy();

    const originalReservation = await prisma.reservation.findUniqueOrThrow({ where: { id: hold.reservationId } });
    expect(originalReservation.status).toBe("expired");

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(1);
    expect(inventory.soldQuantity).toBe(0);
  });

  it("sweepExpiredHolds is idempotent and does not double-release stock", async () => {
    const { category, phase } = await createTestCategory(1);
    const buyer = await createTestUser("sweep");

    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: buyer.id,
      quantity: 1,
    });
    await prisma.reservation.update({
      where: { id: hold.reservationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await sweepExpiredHolds();
    await sweepExpiredHolds(); // calling twice must not release stock twice

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(0);
  });
});
