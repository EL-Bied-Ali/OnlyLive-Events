import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getAuditLog, getAuditLogEntityTypes } from "@/lib/admin/audit";
import { getOrdersForExport } from "@/lib/admin/dashboard";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

async function createAdmin(name = "Reporting Admin") {
  return prisma.adminUser.create({
    data: {
      email: `reporting-admin-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name,
      role: "admin",
    },
  });
}

describe("admin audit log queries", () => {
  it("resolves the admin's display name for entries they authored", async () => {
    const admin = await createAdmin("Nadia Reporting");
    const entityId = crypto.randomUUID();
    await prisma.auditLog.create({
      data: { actorType: "admin", actorId: admin.id, action: "venue.created", entityType: "venue", entityId },
    });

    const { entries } = await getAuditLog({ entityType: "venue" });
    const entry = entries.find((e) => e.entityId === entityId);
    expect(entry?.actorName).toBe("Nadia Reporting");
  });

  it("filters by entity type and never leaks other types", async () => {
    const admin = await createAdmin();
    const uniqueMarker = crypto.randomUUID();
    await prisma.auditLog.create({
      data: { actorType: "admin", actorId: admin.id, action: "event.created", entityType: uniqueMarker, entityId: crypto.randomUUID() },
    });
    await prisma.auditLog.create({
      data: { actorType: "admin", actorId: admin.id, action: "venue.created", entityType: `${uniqueMarker}-other`, entityId: crypto.randomUUID() },
    });

    const { entries } = await getAuditLog({ entityType: uniqueMarker });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entityType).toBe(uniqueMarker);

    const types = await getAuditLogEntityTypes();
    expect(types).toContain(uniqueMarker);
    expect(types).toContain(`${uniqueMarker}-other`);
  });

  it("paginates with a stable cursor that never repeats or skips a row", async () => {
    const admin = await createAdmin();
    const marker = crypto.randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const row = await prisma.auditLog.create({
        data: { actorType: "admin", actorId: admin.id, action: "event.updated", entityType: marker, entityId: crypto.randomUUID() },
      });
      ids.push(row.id);
    }

    const seen = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const result: Awaited<ReturnType<typeof getAuditLog>> = await getAuditLog({
        entityType: marker,
        before: cursor ?? undefined,
      });
      for (const entry of result.entries) seen.add(entry.id);
      cursor = result.nextCursor;
      if (!cursor) break;
    }

    expect(seen.size).toBe(5);
    for (const id of ids) expect(seen.has(id)).toBe(true);
  });

  it("system actions with no actorId never crash name resolution", async () => {
    await prisma.auditLog.create({
      data: { actorType: "system", actorId: null, action: "sweep.completed", entityType: "reservation", entityId: crypto.randomUUID() },
    });

    const { entries } = await getAuditLog({ entityType: "reservation" });
    expect(entries.every((entry) => entry.actorName === null)).toBe(true);
  });
});

describe("admin orders CSV export data", () => {
  it("includes the fields needed for the export and respects a status filter", async () => {
    const { order } = await createOrderAwaitingPayment({ quantity: 2, priceCents: 15_000 });

    const pending = await getOrdersForExport("pending_payment");
    const exported = pending.find((o) => o.id === order.id);
    expect(exported).toBeTruthy();
    expect(exported!.totalAmountCents).toBe(30_000);
    expect(exported!.items[0]!.ticketCategory.name).toBeTruthy();
    expect(exported!.user.email).toContain("@");

    const paidOnly = await getOrdersForExport("paid");
    expect(paidOnly.some((o) => o.id === order.id)).toBe(false);
  });
});
