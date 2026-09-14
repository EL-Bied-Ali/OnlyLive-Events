import "server-only";
import { prisma } from "@/lib/db";

const PAGE_SIZE = 50;

export async function getAuditLogEntityTypes(): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({
    distinct: ["entityType"],
    select: { entityType: true },
    orderBy: { entityType: "asc" },
  });
  return rows.map((row) => row.entityType);
}

export async function getAuditLog(options: { entityType?: string; before?: string } = {}) {
  const entries = await prisma.auditLog.findMany({
    where: options.entityType ? { entityType: options.entityType } : undefined,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: PAGE_SIZE + 1,
    ...(options.before ? { cursor: { id: options.before }, skip: 1 } : {}),
  });

  const hasMore = entries.length > PAGE_SIZE;
  const page = hasMore ? entries.slice(0, PAGE_SIZE) : entries;

  // actorId isn't a declared foreign key (it can point at an AdminUser, a
  // customer User, or be null for system actions), so resolve admin names
  // best-effort for display only — never let a lookup miss block the page.
  const adminActorIds = [...new Set(page.filter((entry) => entry.actorType === "admin" && entry.actorId).map((entry) => entry.actorId!))];
  const admins = adminActorIds.length
    ? await prisma.adminUser.findMany({ where: { id: { in: adminActorIds } }, select: { id: true, name: true } })
    : [];
  const adminNameById = new Map(admins.map((admin) => [admin.id, admin.name]));

  const withActorName = page.map((entry) => ({
    ...entry,
    actorName: entry.actorId ? (adminNameById.get(entry.actorId) ?? null) : null,
  }));

  return { entries: withActorName, nextCursor: hasMore ? page[page.length - 1]!.id : null };
}
