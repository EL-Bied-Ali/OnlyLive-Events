import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  createCategory,
  createSalesPhase,
  updateCategory,
  updateEvent,
  updateSalesPhase,
} from "@/lib/admin/catalog";
import { createHold } from "@/lib/inventory";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

async function createActor() {
  return prisma.adminUser.create({
    data: {
      email: `catalog-admin-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: "Catalogue Admin",
      role: "admin",
    },
  });
}

function eventUpdateInput<T extends {
  id: string;
  slug: string;
  title: string;
  description: string;
  venueId: string;
  startsAt: Date;
  doorsOpenAt: Date | null;
  salesOpenAt: Date;
  salesCloseAt: Date;
  maxTicketsPerUser: number;
  status: "draft" | "published" | "on_sale" | "sold_out" | "closed" | "cancelled";
  coverImageUrl: string | null;
}>(event: T, overrides: Partial<{ maxTicketsPerUser: number; status: T["status"] }> = {}) {
  return {
    eventId: event.id,
    slug: event.slug,
    title: event.title,
    description: event.description,
    venueId: event.venueId,
    startsAt: event.startsAt,
    doorsOpenAt: event.doorsOpenAt ?? undefined,
    salesOpenAt: event.salesOpenAt,
    salesCloseAt: event.salesCloseAt,
    maxTicketsPerUser: overrides.maxTicketsPerUser ?? event.maxTicketsPerUser,
    status: overrides.status ?? event.status,
    coverImageUrl: event.coverImageUrl ?? undefined,
  };
}

async function waitUntilUserEventLockHeld(eventId: string, userId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const acquired = await prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<{ acquired: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtext(${eventId}), hashtext(${userId})) AS acquired
      `;
      return Boolean(rows[0]?.acquired);
    });
    if (!acquired) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for createHold to acquire the user/event advisory lock");
}

describe("admin catalogue integrity", () => {
  it("creates a category and its inventory atomically with an audit record", async () => {
    const { event } = await createTestCategory(10);
    const actor = await createActor();
    const category = await createCategory(
      {
        eventId: event.id,
        name: "Balcon",
        description: "Vue surélevée",
        totalQuantity: 250,
        sortOrder: 2,
        isActive: true,
      },
      actor.id,
    );

    expect(category.inventory?.totalQuantity).toBe(250);
    await expect(
      prisma.auditLog.findFirstOrThrow({
        where: { actorId: actor.id, action: "ticket_category.created", entityId: category.id },
      }),
    ).resolves.toBeTruthy();
  });

  it("refuses to reduce capacity below active reservations", async () => {
    const { event, category, phase } = await createTestCategory(5);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-capacity")]);
    await createHold({ ticketCategoryId: category.id, salesPhaseId: phase.id, userId: customer.id, quantity: 2 });

    await expect(
      updateCategory(
        {
          categoryId: category.id,
          eventId: event.id,
          name: category.name,
          totalQuantity: 1,
          sortOrder: 0,
          isActive: true,
        },
        actor.id,
      ),
    ).rejects.toMatchObject({ code: "CAPACITY_BELOW_COMMITTED", status: 409 });
  });

  it("refuses overlapping active sales phases but permits adjacent windows", async () => {
    const { category, phase } = await createTestCategory(100);
    const actor = await createActor();
    await prisma.salesPhase.update({
      where: { id: phase.id },
      data: { startsAt: new Date("2027-01-01T00:00:00Z"), endsAt: new Date("2027-02-01T00:00:00Z") },
    });

    await expect(
      createSalesPhase(
        {
          ticketCategoryId: category.id,
          name: "Chevauchement",
          priceCents: 20_000,
          startsAt: new Date("2027-01-15T00:00:00Z"),
          endsAt: new Date("2027-03-01T00:00:00Z"),
          sortOrder: 1,
          isActive: true,
        },
        actor.id,
      ),
    ).rejects.toMatchObject({ code: "PHASE_WINDOW_OVERLAP", status: 409 });

    await expect(
      createSalesPhase(
        {
          ticketCategoryId: category.id,
          name: "Phase adjacente",
          priceCents: 25_000,
          startsAt: new Date("2027-02-01T00:00:00Z"),
          endsAt: new Date("2027-03-01T00:00:00Z"),
          sortOrder: 2,
          isActive: true,
        },
        actor.id,
      ),
    ).resolves.toMatchObject({ name: "Phase adjacente" });
  });

  it("refuses to lower a phase cap below already reserved tickets", async () => {
    const { category, phase } = await createTestCategory(10);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-phase-cap")]);
    await createHold({ ticketCategoryId: category.id, salesPhaseId: phase.id, userId: customer.id, quantity: 3 });

    await expect(
      updateSalesPhase(
        {
          phaseId: phase.id,
          ticketCategoryId: category.id,
          name: phase.name,
          priceCents: phase.priceCents,
          startsAt: phase.startsAt,
          endsAt: phase.endsAt ?? undefined,
          phaseQuantityLimit: 2,
          sortOrder: phase.sortOrder,
          isActive: phase.isActive,
        },
        actor.id,
      ),
    ).rejects.toMatchObject({ code: "PHASE_LIMIT_BELOW_COMMITTED", status: 409 });
  });

  it("refuses to lower the per-user event cap below one customer's committed quantity", async () => {
    const { event, category, phase } = await createTestCategory(20);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-user-cap")]);
    await createHold({ ticketCategoryId: category.id, salesPhaseId: phase.id, userId: customer.id, quantity: 3 });

    await expect(updateEvent(eventUpdateInput(event, { maxTicketsPerUser: 2 }), actor.id)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_BELOW_COMMITTED",
      status: 409,
    });

    await expect(prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({
      maxTicketsPerUser: event.maxTicketsPerUser,
    });
  });

  it("keeps converted reservations in the lower-bound calculation", async () => {
    const { event, category, phase } = await createTestCategory(20);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-user-cap-converted")]);
    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: customer.id,
      quantity: 3,
    });
    await prisma.reservation.update({ where: { id: hold.reservationId }, data: { status: "converted" } });

    await expect(updateEvent(eventUpdateInput(event, { maxTicketsPerUser: 2 }), actor.id)).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_BELOW_COMMITTED",
      status: 409,
    });
  });

  it("ignores expired active reservations when lowering the per-user event cap", async () => {
    const { event, category, phase } = await createTestCategory(20);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-user-cap-expired")]);
    const hold = await createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: customer.id,
      quantity: 3,
    });
    await prisma.reservation.update({
      where: { id: hold.reservationId },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });

    await expect(updateEvent(eventUpdateInput(event, { maxTicketsPerUser: 1 }), actor.id)).resolves.toMatchObject({
      maxTicketsPerUser: 1,
    });
  });

  it("allows lowering the per-user event cap to the largest committed quantity and audits the change", async () => {
    const { event, category, phase } = await createTestCategory(20);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-user-cap-exact")]);
    await createHold({ ticketCategoryId: category.id, salesPhaseId: phase.id, userId: customer.id, quantity: 3 });

    const updated = await updateEvent(eventUpdateInput(event, { maxTicketsPerUser: 3 }), actor.id);
    expect(updated.maxTicketsPerUser).toBe(3);

    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { actorId: actor.id, action: "event.updated", entityId: event.id },
      orderBy: { createdAt: "desc" },
    });
    expect(audit.metadata).toMatchObject({
      previousMaxTicketsPerUser: event.maxTicketsPerUser,
      maxTicketsPerUser: 3,
    });
  });

  it("rejects an admin cap decrease when a concurrent customer hold commits first", async () => {
    const { event, category, phase } = await createTestCategory(20);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-user-cap-race")]);

    let releaseInventory!: () => void;
    let inventoryLocked!: () => void;
    const mayReleaseInventory = new Promise<void>((resolve) => { releaseInventory = resolve; });
    const inventoryLockAcquired = new Promise<void>((resolve) => { inventoryLocked = resolve; });

    const blocker = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT ticket_category_id
        FROM inventory
        WHERE ticket_category_id = ${category.id}
        FOR UPDATE
      `;
      inventoryLocked();
      await mayReleaseInventory;
    });

    await inventoryLockAcquired;
    const purchase = createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: customer.id,
      quantity: 3,
    });
    await waitUntilUserEventLockHeld(event.id, customer.id);

    const adminDecrease = updateEvent(eventUpdateInput(event, { maxTicketsPerUser: 2 }), actor.id);
    releaseInventory();
    await blocker;

    await expect(purchase).resolves.toMatchObject({ reservationId: expect.any(String) });
    await expect(adminDecrease).rejects.toMatchObject({
      code: "PURCHASE_LIMIT_BELOW_COMMITTED",
      status: 409,
    });
    await expect(prisma.event.findUniqueOrThrow({ where: { id: event.id } })).resolves.toMatchObject({
      maxTicketsPerUser: event.maxTicketsPerUser,
    });
    await expect(prisma.reservation.count({ where: { userId: customer.id } })).resolves.toBe(1);
  });

  it("blocks direct cancellation after tickets have been issued", async () => {
    const { event, category, phase } = await createTestCategory(1);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-cancel")]);
    const order = await prisma.order.create({
      data: {
        orderNumber: `CAT-${crypto.randomUUID()}`,
        userId: customer.id,
        eventId: event.id,
        status: "paid",
        totalAmountCents: phase.priceCents,
      },
    });
    const item = await prisma.orderItem.create({
      data: {
        orderId: order.id,
        ticketCategoryId: category.id,
        salesPhaseId: phase.id,
        quantity: 1,
        unitPriceCents: phase.priceCents,
      },
    });
    await prisma.ticket.create({
      data: {
        orderItemId: item.id,
        eventId: event.id,
        ticketCategoryId: category.id,
        validationToken: crypto.randomBytes(32).toString("base64url"),
      },
    });

    await expect(
      updateEvent(eventUpdateInput(event, { status: "cancelled" }), actor.id),
    ).rejects.toMatchObject({ code: "CANCELLATION_WORKFLOW_REQUIRED", status: 409 });
  });

  it("blocks direct cancellation while a live hold exists", async () => {
    const { event, category, phase } = await createTestCategory(2);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-live-hold")]);
    await createHold({ ticketCategoryId: category.id, salesPhaseId: phase.id, userId: customer.id, quantity: 1 });

    await expect(
      updateEvent(eventUpdateInput(event, { status: "cancelled" }), actor.id),
    ).rejects.toMatchObject({ code: "CANCELLATION_WORKFLOW_REQUIRED", status: 409 });
  });

  it("blocks direct cancellation while a payment is pending", async () => {
    const { event } = await createTestCategory(2);
    const [actor, customer] = await Promise.all([createActor(), createTestUser("catalog-pending")]);
    await prisma.order.create({
      data: {
        orderNumber: `CAT-PENDING-${crypto.randomUUID()}`,
        userId: customer.id,
        eventId: event.id,
        status: "pending_payment",
        totalAmountCents: 10_000,
      },
    });

    await expect(
      updateEvent(eventUpdateInput(event, { status: "cancelled" }), actor.id),
    ).rejects.toMatchObject({ code: "CANCELLATION_WORKFLOW_REQUIRED", status: 409 });
  });

  it("makes a waiting purchase revalidate after an exclusive catalogue edit", async () => {
    const { event, category, phase } = await createTestCategory(2);
    const customer = await createTestUser("catalog-lock-race");
    let releaseEdit!: () => void;
    let editLocked!: () => void;
    const editMayCommit = new Promise<void>((resolve) => { releaseEdit = resolve; });
    const lockAcquired = new Promise<void>((resolve) => { editLocked = resolve; });

    const edit = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT pg_advisory_xact_lock(hashtext('onlylive_catalogue'), hashtext(${event.id}))
      `;
      editLocked();
      await editMayCommit;
      await tx.ticketCategory.update({ where: { id: category.id }, data: { isActive: false } });
    });

    await lockAcquired;
    const purchase = createHold({
      ticketCategoryId: category.id,
      salesPhaseId: phase.id,
      userId: customer.id,
      quantity: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    releaseEdit();
    await edit;

    await expect(purchase).rejects.toMatchObject({ code: "CATEGORY_NOT_AVAILABLE", status: 409 });
    await expect(prisma.reservation.count({ where: { userId: customer.id } })).resolves.toBe(0);
  });
});
