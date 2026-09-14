import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import type { Prisma, PrismaClient } from "@prisma/client";

export const HOLD_DURATION_MS = 15 * 60 * 1000;
export const CHECKOUT_EXTENSION_MS = 10 * 60 * 1000;

/** Server-side cap on a single hold-creation request. */
export const MAX_QUANTITY_PER_HOLD = 10;

type Tx = Prisma.TransactionClient | PrismaClient;

interface InventorySnapshot {
  total_quantity: number;
  reserved_quantity: number;
  sold_quantity: number;
}

/**
 * Releases stale pre-checkout reservations for one ticket category back onto
 * Inventory and returns the refreshed counters. A reservation with order_id
 * is deliberately excluded: once checkout starts, a provider payment can be
 * in flight and local wall-clock expiry alone is not proof that the session is
 * non-payable. Those rows require provider reconciliation before release.
 *
 * This UPDATE is the lock: Postgres holds the row-level lock it acquires here
 * until the enclosing transaction commits or rolls back, so every subsequent
 * statement in this transaction that touches this same Inventory row is fully
 * serialized against any other transaction doing the same.
 */
async function releaseExpiredAndLock(tx: Tx, ticketCategoryId: string): Promise<InventorySnapshot> {
  const rows = await tx.$queryRaw<InventorySnapshot[]>`
    WITH expired AS (
      UPDATE reservations
      SET status = 'expired'
      WHERE ticket_category_id = ${ticketCategoryId}
        AND status = 'active'
        AND order_id IS NULL
        AND expires_at < now()
      RETURNING quantity
    )
    UPDATE inventory
    SET reserved_quantity = reserved_quantity - COALESCE((SELECT SUM(quantity) FROM expired), 0)::int
    WHERE ticket_category_id = ${ticketCategoryId}
    RETURNING total_quantity, reserved_quantity, sold_quantity
  `;

  const row = rows[0];
  if (!row) {
    throw new ApiError(404, "CATEGORY_NOT_FOUND", "Ticket category has no inventory row");
  }
  return row;
}

export interface CreateHoldInput {
  ticketCategoryId: string;
  salesPhaseId: string;
  userId: string;
  quantity: number;
}

export interface CreateHoldResult {
  reservationId: string;
  expiresAt: Date;
}

/**
 * The critical section: validates full sales eligibility and creates a
 * temporary hold on `quantity` tickets in one category, all atomically
 * inside one transaction — never from a pre-transaction read, since
 * eligibility can otherwise go stale between the check and the mutation.
 *
 * Eligibility enforced here: event.status === 'on_sale', event sales
 * window, category.isActive, phase.isActive + phase window, the phase's
 * optional quantity limit, and the event's per-user purchase limit that
 * can't be bypassed by splitting one purchase into several separate holds.
 *
 * Concurrency: the category-level Inventory row lock (acquired in
 * releaseExpiredAndLock) serializes everything scoped to one category,
 * including the phase-quantity-limit check below, since a phase belongs
 * to exactly one category. The per-user/event limit spans categories, so
 * it needs its own lock: a transaction-scoped Postgres advisory lock
 * keyed on (eventId, userId), acquired before reading the user's current
 * total — this serializes concurrent hold attempts by the SAME user for
 * the SAME event even across different categories/phases, which no
 * per-row lock could do on its own.
 */
export async function createHold(input: CreateHoldInput): Promise<CreateHoldResult> {
  if (input.quantity <= 0 || input.quantity > MAX_QUANTITY_PER_HOLD) {
    throw new ApiError(400, "INVALID_QUANTITY", `Quantity must be between 1 and ${MAX_QUANTITY_PER_HOLD}`);
  }

  return prisma.$transaction(async (tx) => {
    const initialCategory = await tx.ticketCategory.findUnique({
      where: { id: input.ticketCategoryId },
      select: { eventId: true },
    });
    if (!initialCategory) {
      throw new ApiError(409, "CATEGORY_NOT_AVAILABLE", "This ticket category is not available");
    }

    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock_shared(hashtext('onlylive_catalogue'), hashtext(${initialCategory.eventId}))
    `;

    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${initialCategory.eventId}), hashtext(${input.userId}))
    `;

    const snapshot = await releaseExpiredAndLock(tx, input.ticketCategoryId);
    const category = await tx.ticketCategory.findUnique({
      where: { id: input.ticketCategoryId },
      include: { event: true },
    });
    if (!category || !category.isActive) {
      throw new ApiError(409, "CATEGORY_NOT_AVAILABLE", "This ticket category is not available");
    }

    const event = category.event;
    const now = new Date();
    if (event.status !== "on_sale") {
      throw new ApiError(409, "EVENT_NOT_ON_SALE", "This event is not currently on sale");
    }
    if (event.salesOpenAt > now || event.salesCloseAt < now) {
      throw new ApiError(409, "EVENT_SALES_CLOSED", "Sales are not open for this event");
    }

    const phase = await tx.salesPhase.findUnique({ where: { id: input.salesPhaseId } });
    if (
      !phase ||
      phase.ticketCategoryId !== input.ticketCategoryId ||
      !phase.isActive ||
      phase.startsAt > now ||
      (phase.endsAt && phase.endsAt <= now)
    ) {
      throw new ApiError(409, "PHASE_NOT_AVAILABLE", "This sales phase is not currently open");
    }

    // Converted reservations count permanently. Active pre-checkout holds only
    // count while their local expiry is live; order-linked checkout holds are
    // protected from lazy release above and continue to represent committed
    // checkout inventory until payment reconciliation resolves them.
    const userTotals = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM(r.quantity), 0) AS total
      FROM reservations r
      JOIN ticket_categories tc ON tc.id = r.ticket_category_id
      WHERE r.user_id = ${input.userId}
        AND tc.event_id = ${event.id}
        AND (
          r.status = 'converted'
          OR (r.status = 'active' AND (r.expires_at >= now() OR r.order_id IS NOT NULL))
        )
    `;
    const currentUserTotal = Number(userTotals[0]?.total ?? 0);
    if (currentUserTotal + input.quantity > event.maxTicketsPerUser) {
      throw new ApiError(
        409,
        "PURCHASE_LIMIT_EXCEEDED",
        `You can reserve at most ${event.maxTicketsPerUser} tickets for this event`,
      );
    }

    const available = snapshot.total_quantity - snapshot.reserved_quantity - snapshot.sold_quantity;
    if (available < input.quantity) {
      throw new ApiError(409, "SOLD_OUT", "Not enough tickets available in this category");
    }

    if (phase.phaseQuantityLimit !== null) {
      const phaseTotals = await tx.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(quantity), 0) AS total FROM reservations
        WHERE sales_phase_id = ${input.salesPhaseId} AND status IN ('active', 'converted')
      `;
      const currentPhaseTotal = Number(phaseTotals[0]?.total ?? 0);
      if (currentPhaseTotal + input.quantity > phase.phaseQuantityLimit) {
        throw new ApiError(409, "PHASE_SOLD_OUT", "Not enough tickets available in this sales phase");
      }
    }

    await tx.$executeRaw`
      UPDATE inventory
      SET reserved_quantity = reserved_quantity + ${input.quantity}
      WHERE ticket_category_id = ${input.ticketCategoryId}
    `;

    const expiresAt = new Date(Date.now() + HOLD_DURATION_MS);
    const reservation = await tx.reservation.create({
      data: {
        ticketCategoryId: input.ticketCategoryId,
        salesPhaseId: input.salesPhaseId,
        userId: input.userId,
        quantity: input.quantity,
        unitPriceCents: phase.priceCents,
        status: "active",
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    return { reservationId: reservation.id, expiresAt: reservation.expiresAt };
  });
}

/**
 * Explicit cancellation (abandoned checkout, user backing out) — but only
 * while the hold has NOT yet moved into checkout. Once reservation.orderId is
 * set, a Payment may already be in flight and stock cannot be released without
 * provider reconciliation.
 */
export async function releaseHold(reservationId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation || reservation.userId !== userId) {
      throw new ApiError(404, "RESERVATION_NOT_FOUND", "Reservation not found");
    }
    if (reservation.status !== "active") {
      return;
    }
    if (reservation.orderId) {
      throw new ApiError(
        409,
        "CHECKOUT_IN_PROGRESS",
        "This reservation is already in checkout and cannot be released directly",
      );
    }

    const updated = await tx.reservation.updateMany({
      where: { id: reservationId, status: "active", orderId: null },
      data: { status: "cancelled" },
    });
    if (updated.count === 0) return;

    await tx.$executeRaw`
      UPDATE inventory
      SET reserved_quantity = reserved_quantity - ${reservation.quantity}
      WHERE ticket_category_id = ${reservation.ticketCategoryId}
    `;
  });
}

/**
 * Proactive sweep for stale PRE-CHECKOUT holds only. Order-linked checkout
 * reservations are intentionally excluded because local time alone cannot
 * prove the hosted PSP session is no longer payable. A provider-aware
 * reconciliation path must resolve those before inventory is released.
 */
export async function sweepExpiredHolds(): Promise<{ categoriesAffected: number }> {
  const result = await prisma.$executeRaw`
    WITH expired AS (
      UPDATE reservations
      SET status = 'expired'
      WHERE status = 'active'
        AND order_id IS NULL
        AND expires_at < now()
      RETURNING ticket_category_id, quantity
    ),
    agg AS (
      SELECT ticket_category_id, SUM(quantity)::int AS qty
      FROM expired
      GROUP BY ticket_category_id
    )
    UPDATE inventory i
    SET reserved_quantity = i.reserved_quantity - agg.qty
    FROM agg
    WHERE i.ticket_category_id = agg.ticket_category_id
  `;
  return { categoriesAffected: Number(result) };
}
