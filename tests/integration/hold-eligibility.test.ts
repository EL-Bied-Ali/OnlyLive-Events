import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { createHold, MAX_TICKETS_PER_USER_PER_EVENT } from "@/lib/inventory";
import { createTestCategoryWithOverrides, createTestUser } from "../helpers/fixtures";

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
      totalQuantity: 100, // category has plenty of stock —
      phaseQuantityLimit: 3, // but this phase itself is capped at 3
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

    // Category-level inventory must reflect exactly the phase-capped
    // amount, not the full category stock.
    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: category.id } });
    expect(inventory.reservedQuantity).toBe(3);
  });

  it("enforces a per-user/event purchase limit that can't be bypassed by splitting into several separate holds", async () => {
    const { category, phase } = await createTestCategoryWithOverrides({ totalQuantity: 1000 });
    const user = await createTestUser("limit-bypass");

    // Buy up to the limit across several separate one-at-a-time holds.
    for (let i = 0; i < MAX_TICKETS_PER_USER_PER_EVENT; i++) {
      await attemptHold(category, phase, user.id, 1);
    }

    // One more hold, even for a single ticket, must be refused —
    // splitting into small requests must not bypass the cap.
    await expect(attemptHold(category, phase, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });

    const total = await prisma.reservation.aggregate({
      where: { userId: user.id, ticketCategoryId: category.id, status: "active" },
      _sum: { quantity: true },
    });
    expect(total._sum.quantity).toBe(MAX_TICKETS_PER_USER_PER_EVENT);
  });

  it("enforces the per-user/event purchase limit across different categories of the same event", async () => {
    const { event, category: categoryA, phase: phaseA } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
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

    await attemptHold(categoryA, phaseA, user.id, MAX_TICKETS_PER_USER_PER_EVENT - 2);
    await attemptHold(categoryB, phaseB, user.id, 2); // total now at the limit, across two categories

    await expect(attemptHold(categoryA, phaseA, user.id, 1)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_EXCEEDED",
    });
  });

  it("rejects concurrent same-user holds across categories that together would exceed the limit", async () => {
    const { event, category: categoryA, phase: phaseA } = await createTestCategoryWithOverrides({
      totalQuantity: 1000,
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
    const half = Math.ceil(MAX_TICKETS_PER_USER_PER_EVENT / 2);

    // Two concurrent requests, different categories, same user+event —
    // each individually within the limit, but together over it. Only
    // the advisory lock (not the per-category Inventory lock) can catch
    // this, since it spans categories.
    const results = await Promise.allSettled([
      attemptHold(categoryA, phaseA, user.id, half),
      attemptHold(categoryB, phaseB, user.id, MAX_TICKETS_PER_USER_PER_EVENT - half + 1),
    ]);

    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });
});
