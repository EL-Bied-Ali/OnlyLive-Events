import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createHold } from "@/lib/inventory";
import { createTestCategoryWithOverrides, createTestUser } from "../helpers/fixtures";

const DEFAULT_TEST_PURCHASE_LIMIT = 10;

async function attemptHold(category: { id: string }, phase: { id: string }, userId: string, quantity = 1) {
  return createHold({ ticketCategoryId: category.id, salesPhaseId: phase.id, userId, quantity });
}

describe("hold creation — sales eligibility gate", () => {
  it.each(["draft", "cancelled", "sold_out", "closed", "published"] as const)(
    "refuses to create a hold when the event status is %s",
    async (eventStatus) => {
      const { category, phase } = await createTestCategoryWithOverrides({ eventStatus });
      const user = await createTestUser("status-check");

      await expect(attemptHold(category, phase, user.id)).rejects.toMatchObject({ code: "EVENT_NOT_ON_SALE" });
    },
  );

  it("refuses a hold before the event's sales window opens", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({
      salesOpenAt: new Date(Date.now() + 86_400_000),
    });
    const user = await createTestUser("before-open");

    await expect(attemptHold(category, phase, user.id)).rejects.toMatchObject({ code: "EVENT_SALES_CLOSED" });
  });

  it("refuses a hold after the event's sales window has closed", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({
      salesOpenAt: new Date(Date.now() - 2 * 86_400_000),
      salesCloseAt: new Date(Date.now() - 86_400_000),
    });
    const user = await createTestUser("after-close");

    await expect(attemptHold(category, phase, user.id)).rejects.toMatchObject({ code: "EVENT_SALES_CLOSED" });
  });

  it("refuses a hold in an inactive ticket category", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({ categoryIsActive: false });
    const user = await createTestUser("inactive-category");

    await expect(attemptHold(category, phase, user.id)).rejects.toMatchObject({ code: "CATEGORY_NOT_AVAILABLE" });
  });

  it("refuses a hold in an inactive sales phase", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({ phaseIsActive: false });
    const user = await createTestUser("inactive-phase");

    await expect(attemptHold(category, phase, user.id)).rejects.toMatchObject({ code: "PHASE_NOT_AVAILABLE" });
  });

  it("refuses a hold before the phase opens or after it ends", async () => {
    const future = await createTestCategoryWithOverrides({ phaseStartsAt: new Date(Date.now() + 86_400_000) });
    const user1 = await createTestUser("phase-not-open");
    await expect(attemptHold(future.category, future.phase, user1.id)).rejects.toMatchObject({
      code: "PHASE_NOT_AVAILABLE",
    });

    const past = await createTestCategoryWithOverrides({
      phaseStartsAt: new Date(Date.now() - 2 * 86_400_000),
      phaseEndsAt: new Date(Date.now() - 86_400_000),
    });
    const user2 = await createTestUser("phase-ended");
    await expect(attemptHold(past.category, past.phase, user2.id)).rejects.toMatchObject({
      code: "PHASE_NOT_AVAILABLE",
    });
  });

  it("enforces the sales phase's quantity limit even under concurrent buyers", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({
      totalQuantity: 100,
      phaseQuantityLimit: 3,
    });
    const buyers = await Promise.all(Array.from({ length: 5 }, (_, i) => createTestUser(`phase-limit-${i}`)));

    const results = await Promise.allSettled(buyers.map((buyer) => attemptHold(category, phase, buyer.id)));

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(2);
    for (const r of rejected) {
      if (r.status === "rejected") {
        expect(r.reason).toMatchObject({ code: "PHASE_SOLD_OUT" });
      }
    }

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(3);
  });

  it("enforces a per-user/event purchase limit that can't be bypassed by splitting into several separate holds", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
      maxTicketsPerUser: DEFAULT_TEST_PURCHASE_LIMIT,
    });
    const user = await createTestUser("limit-bypass");

    for (let i = 0; i < DEFAULT_TEST_PURCHASE_LIMIT; i++) {
      await attemptHold(category, phase, user.id, 1);
    }

    await expect(attemptHold(category, phase, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });

    const total = await prisma.reservation.aggregate({
      where: { userId: user.id, ticketCategoryId: category.id, status: "active" },
      _sum: { quantity: true },
    });
    expect(total._sum.quantity).toBe(DEFAULT_TEST_PURCHASE_LIMIT);
  });

  it("uses each event's configured purchase limit independently", async () => {
    const low = await createTestCategoryWithOverrides({ totalQuantity: 100, maxTicketsPerUser: 2 });
    const high = await createTestCategoryWithOverrides({ totalQuantity: 100, maxTicketsPerUser: 4 });
    const user = await createTestUser("per-event-limits");

    await attemptHold(low.category, low.phase, user.id, 2);
    await expect(attemptHold(low.category, low.phase, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });

    await attemptHold(high.category, high.phase, user.id, 4);
    await expect(attemptHold(high.category, high.phase, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });
  });

  it("an expired-but-unswept hold does not keep consuming the user's purchase allowance", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
      maxTicketsPerUser: DEFAULT_TEST_PURCHASE_LIMIT,
    });
    const user = await createTestUser("expired-limit-exclusion");

    const holds = [];
    for (let i = 0; i < DEFAULT_TEST_PURCHASE_LIMIT; i++) {
      holds.push(await attemptHold(category, phase, user.id, 1));
    }

    await expect(attemptHold(category, phase, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });

    await prisma.reservation.update({
      where: { id: holds[0]!.reservationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const stillActiveInDb = await prisma.reservation.findUniqueOrThrow({ where: { id: holds[0]!.reservationId } });
    expect(stillActiveInDb.status).toBe("active");

    const newHold = await attemptHold(category, phase, user.id, 1);
    expect(newHold.reservationId).toBeTruthy();

    const expiredReservation = await prisma.reservation.findUniqueOrThrow({
      where: { id: holds[0]!.reservationId },
    });
    expect(expiredReservation.status).toBe("expired");

    const activeCount = await prisma.reservation.count({
      where: { ticketCategoryId: category.id, userId: user.id, status: "active" },
    });
    expect(activeCount).toBe(DEFAULT_TEST_PURCHASE_LIMIT);

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(DEFAULT_TEST_PURCHASE_LIMIT);
  });

  it("excludes an expired-but-unswept hold from the purchase limit even in a different category, without touching that category's inventory", async () => {
    const { event, category: categoryA, phase: phaseA } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
      maxTicketsPerUser: DEFAULT_TEST_PURCHASE_LIMIT,
    });
    const categoryB = await prisma.ticketCategory.create({ data: { eventId: event.id, name: "Category B-expiry" } });
    await prisma.inventory.create({ data: { ticketCategoryId: categoryB.id, totalQuantity: 1000 } });
    const phaseB = await prisma.salesPhase.create({
      data: {
        ticketCategoryId: categoryB.id,
        name: "Phase B-expiry",
        priceCents: 5000,
        startsAt: new Date(Date.now() - 3_600_000),
      },
    });

    const user = await createTestUser("cross-category-expired-limit");

    await attemptHold(categoryA, phaseA, user.id, DEFAULT_TEST_PURCHASE_LIMIT - 1);
    const holdB = await attemptHold(categoryB, phaseB, user.id, 1);

    await prisma.reservation.update({
      where: { id: holdB.reservationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    const newHold = await attemptHold(categoryA, phaseA, user.id, 1);
    expect(newHold.reservationId).toBeTruthy();

    const stillActiveInDb = await prisma.reservation.findUniqueOrThrow({ where: { id: holdB.reservationId } });
    expect(stillActiveInDb.status).toBe("active");
    const inventoryB = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: categoryB.id } });
    expect(inventoryB.reservedQuantity).toBe(1);
  });

  it("enforces the per-user/event purchase limit across different categories of the same event", async () => {
    const { event, category: categoryA, phase: phaseA } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
      maxTicketsPerUser: DEFAULT_TEST_PURCHASE_LIMIT,
    });
    const categoryB = await prisma.ticketCategory.create({ data: { eventId: event.id, name: "Category B" } });
    await prisma.inventory.create({ data: { ticketCategoryId: categoryB.id, totalQuantity: 1000 } });
    const phaseB = await prisma.salesPhase.create({
      data: {
        ticketCategoryId: categoryB.id,
        name: "Phase B1",
        priceCents: 5000,
        startsAt: new Date(Date.now() - 3_600_000),
      },
    });

    const user = await createTestUser("cross-category-limit");

    await attemptHold(categoryA, phaseA, user.id, DEFAULT_TEST_PURCHASE_LIMIT - 2);
    await attemptHold(categoryB, phaseB, user.id, 2);

    await expect(attemptHold(categoryA, phaseA, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });
  });

  it("rejects concurrent same-user holds across categories that together would exceed the limit", async () => {
    const { event, category: categoryA, phase: phaseA } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
      maxTicketsPerUser: DEFAULT_TEST_PURCHASE_LIMIT,
    });
    const categoryB = await prisma.ticketCategory.create({ data: { eventId: event.id, name: "Category B2" } });
    await prisma.inventory.create({ data: { ticketCategoryId: categoryB.id, totalQuantity: 1000 } });
    const phaseB = await prisma.salesPhase.create({
      data: {
        ticketCategoryId: categoryB.id,
        name: "Phase B2",
        priceCents: 5000,
        startsAt: new Date(Date.now() - 3_600_000),
      },
    });

    const user = await createTestUser("cross-category-concurrent-limit");
    const half = Math.ceil(DEFAULT_TEST_PURCHASE_LIMIT / 2);

    const results = await Promise.allSettled([
      attemptHold(categoryA, phaseA, user.id, half),
      attemptHold(categoryB, phaseB, user.id, DEFAULT_TEST_PURCHASE_LIMIT - half + 1),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
