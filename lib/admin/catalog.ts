import "server-only";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import type { Prisma } from "@prisma/client";
import type {
  CategoryMutationInput,
  EventMutationInput,
  SalesPhaseMutationInput,
  VenueMutationInput,
} from "@/lib/validation/catalog";

type Tx = Prisma.TransactionClient;

async function lockEvent(tx: Tx, eventId: string): Promise<void> {
  // Catalogue writes take an exclusive advisory lock. Checkout takes the
  // matching shared lock, so many buyers remain concurrent while an admin
  // edit can never race a sale that already validated stale catalogue data.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('onlylive_catalogue'), hashtext(${eventId}))`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM events WHERE id = ${eventId}
  `;
  if (rows.length === 0) {
    throw new ApiError(404, "EVENT_NOT_FOUND", "Événement introuvable");
  }
}

async function lockInventory(tx: Tx, categoryId: string) {
  const rows = await tx.$queryRaw<
    { total_quantity: number; reserved_quantity: number; sold_quantity: number }[]
  >`
    SELECT total_quantity, reserved_quantity, sold_quantity
    FROM inventory
    WHERE ticket_category_id = ${categoryId}
    FOR UPDATE
  `;
  const inventory = rows[0];
  if (!inventory) {
    throw new ApiError(404, "CATEGORY_NOT_FOUND", "Catégorie ou inventaire introuvable");
  }
  return inventory;
}

function audit(
  tx: Tx,
  actorId: string,
  action: string,
  entityType: string,
  entityId: string,
  metadata?: Prisma.InputJsonValue,
) {
  return tx.auditLog.create({
    data: { actorType: "admin", actorId, action, entityType, entityId, metadata },
  });
}

export async function createVenue(input: VenueMutationInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.create({ data: input });
    await audit(tx, actorId, "venue.created", "venue", venue.id, {
      name: venue.name,
      city: venue.city,
      capacity: venue.capacity,
    });
    return venue;
  });
}

export async function createEvent(input: EventMutationInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const venue = await tx.venue.findUnique({ where: { id: input.venueId }, select: { id: true } });
    if (!venue) {
      throw new ApiError(404, "VENUE_NOT_FOUND", "Lieu introuvable");
    }
    const slugExists = await tx.event.findFirst({ where: { slug: input.slug }, select: { id: true } });
    if (slugExists) {
      throw new ApiError(409, "SLUG_ALREADY_USED", "Cette URL d’événement est déjà utilisée");
    }

    const event = await tx.event.create({
      data: {
        slug: input.slug,
        title: input.title,
        description: input.description,
        venueId: input.venueId,
        startsAt: input.startsAt,
        doorsOpenAt: input.doorsOpenAt ?? null,
        salesOpenAt: input.salesOpenAt,
        salesCloseAt: input.salesCloseAt,
        maxTicketsPerUser: input.maxTicketsPerUser,
        status: input.status,
        coverImageUrl: input.coverImageUrl ?? null,
        createdById: actorId,
      },
    });
    await audit(tx, actorId, "event.created", "event", event.id, {
      title: event.title,
      slug: event.slug,
      status: event.status,
      maxTicketsPerUser: event.maxTicketsPerUser,
    });
    return event;
  });
}

export async function updateEvent(input: EventMutationInput & { eventId: string }, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await lockEvent(tx, input.eventId);
    const current = await tx.event.findUnique({ where: { id: input.eventId } });
    if (!current) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Événement introuvable");
    }
    const venue = await tx.venue.findUnique({ where: { id: input.venueId }, select: { id: true } });
    if (!venue) {
      throw new ApiError(404, "VENUE_NOT_FOUND", "Lieu introuvable");
    }
    const slugExists = await tx.event.findFirst({
      where: { slug: input.slug, id: { not: input.eventId } },
      select: { id: true },
    });
    if (slugExists) {
      throw new ApiError(409, "SLUG_ALREADY_USED", "Cette URL d’événement est déjà utilisée");
    }

    if (input.maxTicketsPerUser < current.maxTicketsPerUser) {
      // The exclusive event catalogue lock above also blocks createHold's
      // shared lock, so this maximum cannot increase while we validate the
      // new cap. Expired active reservations are excluded exactly like the
      // purchase-time limit check in lib/inventory.ts.
      const rows = await tx.$queryRaw<{ max_total: bigint }[]>`
        SELECT COALESCE(MAX(user_total), 0) AS max_total
        FROM (
          SELECT SUM(r.quantity)::bigint AS user_total
          FROM reservations r
          JOIN ticket_categories tc ON tc.id = r.ticket_category_id
          WHERE tc.event_id = ${input.eventId}
            AND (r.status = 'converted' OR (r.status = 'active' AND r.expires_at >= (now() AT TIME ZONE 'UTC')))
          GROUP BY r.user_id
        ) committed_by_user
      `;
      const largestCommittedTotal = Number(rows[0]?.max_total ?? 0);
      if (input.maxTicketsPerUser < largestCommittedTotal) {
        throw new ApiError(
          409,
          "PURCHASE_LIMIT_BELOW_COMMITTED",
          `La limite ne peut pas être inférieure aux ${largestCommittedTotal} billets déjà vendus ou réservés par un client`,
        );
      }
    }

    if (input.status === "cancelled" && current.status !== "cancelled") {
      const [issuedTickets, liveReservations, pendingOrders] = await Promise.all([
        tx.ticket.count({ where: { eventId: input.eventId } }),
        tx.reservation.count({
          where: {
            ticketCategory: { eventId: input.eventId },
            status: "active",
            expiresAt: { gte: new Date() },
          },
        }),
        tx.order.count({ where: { eventId: input.eventId, status: "pending_payment" } }),
      ]);
      if (issuedTickets > 0 || liveReservations > 0 || pendingOrders > 0) {
        throw new ApiError(
          409,
          "CANCELLATION_WORKFLOW_REQUIRED",
          "Des billets, réservations ou paiements sont en cours : utilisez d’abord le futur workflow d’annulation/remboursement",
        );
      }
    }

    const event = await tx.event.update({
      where: { id: input.eventId },
      data: {
        slug: input.slug,
        title: input.title,
        description: input.description,
        venueId: input.venueId,
        startsAt: input.startsAt,
        doorsOpenAt: input.doorsOpenAt ?? null,
        salesOpenAt: input.salesOpenAt,
        salesCloseAt: input.salesCloseAt,
        maxTicketsPerUser: input.maxTicketsPerUser,
        status: input.status,
        coverImageUrl: input.coverImageUrl ?? null,
      },
    });
    await audit(tx, actorId, "event.updated", "event", event.id, {
      previousStatus: current.status,
      status: event.status,
      title: event.title,
      slug: event.slug,
      previousMaxTicketsPerUser: current.maxTicketsPerUser,
      maxTicketsPerUser: event.maxTicketsPerUser,
    });
    return event;
  });
}

export async function createCategory(input: CategoryMutationInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    await lockEvent(tx, input.eventId);
    const duplicate = await tx.ticketCategory.findFirst({
      where: { eventId: input.eventId, name: input.name },
      select: { id: true },
    });
    if (duplicate) {
      throw new ApiError(409, "CATEGORY_NAME_USED", "Cette catégorie existe déjà pour l’événement");
    }
    const category = await tx.ticketCategory.create({
      data: {
        eventId: input.eventId,
        name: input.name,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        inventory: { create: { totalQuantity: input.totalQuantity } },
      },
      include: { inventory: true },
    });
    await audit(tx, actorId, "ticket_category.created", "ticket_category", category.id, {
      eventId: input.eventId,
      name: category.name,
      totalQuantity: input.totalQuantity,
    });
    return category;
  });
}

export async function updateCategory(
  input: CategoryMutationInput & { categoryId: string },
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.ticketCategory.findUnique({ where: { id: input.categoryId } });
    if (!category || category.eventId !== input.eventId) {
      throw new ApiError(404, "CATEGORY_NOT_FOUND", "Catégorie introuvable");
    }
    await lockEvent(tx, category.eventId);
    const inventory = await lockInventory(tx, category.id);
    const committed = inventory.reserved_quantity + inventory.sold_quantity;
    if (input.totalQuantity < committed) {
      throw new ApiError(
        409,
        "CAPACITY_BELOW_COMMITTED",
        `La capacité ne peut pas être inférieure aux ${committed} billets vendus ou réservés`,
      );
    }
    const duplicate = await tx.ticketCategory.findFirst({
      where: { eventId: category.eventId, name: input.name, id: { not: category.id } },
      select: { id: true },
    });
    if (duplicate) {
      throw new ApiError(409, "CATEGORY_NAME_USED", "Cette catégorie existe déjà pour l’événement");
    }

    const updated = await tx.ticketCategory.update({
      where: { id: category.id },
      data: {
        name: input.name,
        description: input.description ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
        inventory: { update: { totalQuantity: input.totalQuantity } },
      },
      include: { inventory: true },
    });
    await audit(tx, actorId, "ticket_category.updated", "ticket_category", category.id, {
      eventId: category.eventId,
      previousTotalQuantity: inventory.total_quantity,
      totalQuantity: input.totalQuantity,
      isActive: input.isActive,
    });
    return updated;
  });
}

async function ensurePhaseDoesNotOverlap(
  tx: Tx,
  input: SalesPhaseMutationInput,
  excludedPhaseId?: string,
) {
  if (!input.isActive) return;
  const overlap = await tx.salesPhase.findFirst({
    where: {
      ticketCategoryId: input.ticketCategoryId,
      isActive: true,
      id: excludedPhaseId ? { not: excludedPhaseId } : undefined,
      startsAt: { lt: input.endsAt ?? new Date("9999-12-31T23:59:59.999Z") },
      OR: [{ endsAt: null }, { endsAt: { gt: input.startsAt } }],
    },
    select: { name: true },
  });
  if (overlap) {
    throw new ApiError(409, "PHASE_WINDOW_OVERLAP", `La période chevauche la phase active « ${overlap.name} »`);
  }
}

export async function createSalesPhase(input: SalesPhaseMutationInput, actorId: string) {
  return prisma.$transaction(async (tx) => {
    const category = await tx.ticketCategory.findUnique({ where: { id: input.ticketCategoryId } });
    if (!category) {
      throw new ApiError(404, "CATEGORY_NOT_FOUND", "Catégorie introuvable");
    }
    await lockEvent(tx, category.eventId);
    const inventory = await lockInventory(tx, category.id);
    if (input.phaseQuantityLimit && input.phaseQuantityLimit > inventory.total_quantity) {
      throw new ApiError(409, "PHASE_LIMIT_ABOVE_CAPACITY", "Le plafond de phase dépasse la capacité de la catégorie");
    }
    await ensurePhaseDoesNotOverlap(tx, input);

    const phase = await tx.salesPhase.create({
      data: {
        ticketCategoryId: input.ticketCategoryId,
        name: input.name,
        priceCents: input.priceCents,
        currency: "MAD",
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        phaseQuantityLimit: input.phaseQuantityLimit ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
    await audit(tx, actorId, "sales_phase.created", "sales_phase", phase.id, {
      ticketCategoryId: category.id,
      priceCents: phase.priceCents,
      phaseQuantityLimit: phase.phaseQuantityLimit,
    });
    return phase;
  });
}

export async function updateSalesPhase(
  input: SalesPhaseMutationInput & { phaseId: string },
  actorId: string,
) {
  return prisma.$transaction(async (tx) => {
    const phase = await tx.salesPhase.findUnique({
      where: { id: input.phaseId },
      include: { ticketCategory: true },
    });
    if (!phase || phase.ticketCategoryId !== input.ticketCategoryId) {
      throw new ApiError(404, "PHASE_NOT_FOUND", "Phase de vente introuvable");
    }
    await lockEvent(tx, phase.ticketCategory.eventId);
    const inventory = await lockInventory(tx, phase.ticketCategoryId);
    if (input.phaseQuantityLimit && input.phaseQuantityLimit > inventory.total_quantity) {
      throw new ApiError(409, "PHASE_LIMIT_ABOVE_CAPACITY", "Le plafond de phase dépasse la capacité de la catégorie");
    }

    if (input.phaseQuantityLimit) {
      const totals = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(quantity), 0) AS total
        FROM reservations
        WHERE sales_phase_id = ${phase.id}
          AND (status = 'converted' OR (status = 'active' AND expires_at >= (now() AT TIME ZONE 'UTC')))
      `;
      const committed = Number(totals[0]?.total ?? 0);
      if (input.phaseQuantityLimit < committed) {
        throw new ApiError(
          409,
          "PHASE_LIMIT_BELOW_COMMITTED",
          `Le plafond ne peut pas être inférieur aux ${committed} billets déjà vendus ou réservés`,
        );
      }
    }
    await ensurePhaseDoesNotOverlap(tx, input, phase.id);

    const updated = await tx.salesPhase.update({
      where: { id: phase.id },
      data: {
        name: input.name,
        priceCents: input.priceCents,
        startsAt: input.startsAt,
        endsAt: input.endsAt ?? null,
        phaseQuantityLimit: input.phaseQuantityLimit ?? null,
        sortOrder: input.sortOrder,
        isActive: input.isActive,
      },
    });
    await audit(tx, actorId, "sales_phase.updated", "sales_phase", phase.id, {
      ticketCategoryId: phase.ticketCategoryId,
      previousPriceCents: phase.priceCents,
      priceCents: updated.priceCents,
      isActive: updated.isActive,
    });
    return updated;
  });
}
