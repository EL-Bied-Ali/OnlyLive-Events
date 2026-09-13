import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import type { Prisma, PrismaClient } from "@prisma/client";

export const HOLD_DURATION_MS = 15 * 60 * 1000;
export const CHECKOUT_EXTENSION_MS = 10 * 60 * 1000;

type Tx = Prisma.TransactionClient | PrismaClient;

interface InventorySnapshot {
  total_quantity: number;
  reserved_quantity: number;
  sold_quantity: number;
}

/**
 * Releases any stale `active` reservations for one ticket category back
 * onto its Inventory row, and returns the refreshed counters.
 *
 * This UPDATE is the lock: Postgres holds the row-level lock it acquires
 * here until the enclosing transaction commits or rolls back, so every
 * subsequent statement in this transaction that touches this same
 * Inventory row is fully serialized against any other transaction doing
 * the same. That is the entire oversell-prevention mechanism — no
 * SERIALIZABLE isolation or retry loop is needed for a single-row
 * read-modify-write.
 */
async function releaseExpiredAndLock(tx: Tx, ticketCategoryId: string): Promise<InventorySnapshot> {
  const rows = await tx.$queryRaw<InventorySnapshot[]>`
    WITH expired AS (
      UPDATE reservations
      SET status = 'expired'
      WHERE ticket_category_id = ${ticketCategoryId}
        AND status = 'active'
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
  unitPriceCents: number;
}

export interface CreateHoldResult {
  reservationId: string;
  expiresAt: Date;
}

/**
 * The critical section: creates a temporary hold on `quantity` tickets in
 * one category, failing with 409 SOLD_OUT if not enough stock remains.
 * Two concurrent buyers racing for the last seat serialize through the
 * Inventory row lock acquired in releaseExpiredAndLock — the loser's
 * transaction blocks until the winner commits, then re-reads the
 * winner's committed numbers and correctly sees zero availability.
 */
export async function createHold(input: CreateHoldInput): Promise<CreateHoldResult> {
  if (input.quantity <= 0) {
    throw new ApiError(400, "INVALID_QUANTITY", "Quantity must be positive");
  }

  return prisma.$transaction(async (tx) => {
    const snapshot = await releaseExpiredAndLock(tx, input.ticketCategoryId);

    const available = snapshot.total_quantity - snapshot.reserved_quantity - snapshot.sold_quantity;
    if (available < input.quantity) {
      throw new ApiError(409, "SOLD_OUT", "Not enough tickets available in this category");
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
        unitPriceCents: input.unitPriceCents,
        status: "active",
        expiresAt,
      },
      select: { id: true, expiresAt: true },
    });

    return { reservationId: reservation.id, expiresAt: reservation.expiresAt };
  });
}

/**
 * Explicit cancellation (abandoned checkout, user backing out). Releases
 * the reservation's stock immediately rather than waiting for lazy/sweep
 * expiry. No-ops safely if the reservation is already
 * converted/expired/cancelled.
 */
export async function releaseHold(reservationId: string, userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const reservation = await tx.reservation.findUnique({ where: { id: reservationId } });
    if (!reservation || reservation.userId !== userId) {
      throw new ApiError(404, "RESERVATION_NOT_FOUND", "Reservation not found");
    }
    if (reservation.status !== "active") {
      return; // already converted/expired/cancelled — nothing to release
    }

    const updated = await tx.reservation.updateMany({
      where: { id: reservationId, status: "active" },
      data: { status: "cancelled" },
    });
    if (updated.count === 0) {
      return; // raced with expiry/conversion — the other path already handled stock
    }

    await tx.$executeRaw`
      UPDATE inventory
      SET reserved_quantity = reserved_quantity - ${reservation.quantity}
      WHERE ticket_category_id = ${reservation.ticketCategoryId}
    `;
  });
}

export interface ActiveReservation {
  id: string;
  ticketCategoryId: string;
  salesPhaseId: string;
  userId: string;
  quantity: number;
  unitPriceCents: number;
  expiresAt: Date;
}

/**
 * Moving from hold to checkout extends the hold's expiry once, inside a
 * guarded UPDATE (`status = 'active' AND expires_at > now()`), to shrink
 * — not eliminate — the window where a payment could succeed after the
 * hold already expired and its stock was resold. The residual race is
 * handled explicitly in the payment webhook (see lib/orders/stateMachine.ts
 * and the `paid_but_unfulfillable` order status).
 */
export async function extendHoldForCheckout(reservationId: string, userId: string): Promise<ActiveReservation> {
  const rows = await prisma.$queryRaw<
    {
      id: string;
      ticket_category_id: string;
      sales_phase_id: string;
      user_id: string;
      quantity: number;
      unit_price_cents: number;
      expires_at: Date;
    }[]
  >`
    UPDATE reservations
    SET expires_at = now() + (${CHECKOUT_EXTENSION_MS} || ' milliseconds')::interval
    WHERE id = ${reservationId}
      AND user_id = ${userId}
      AND status = 'active'
      AND expires_at > now()
    RETURNING id, ticket_category_id, sales_phase_id, user_id, quantity, unit_price_cents, expires_at
  `;

  const row = rows[0];
  if (!row) {
    throw new ApiError(409, "HOLD_EXPIRED", "This reservation has expired or is no longer active");
  }

  return {
    id: row.id,
    ticketCategoryId: row.ticket_category_id,
    salesPhaseId: row.sales_phase_id,
    userId: row.user_id,
    quantity: row.quantity,
    unitPriceCents: row.unit_price_cents,
    expiresAt: row.expires_at,
  };
}

/**
 * Proactive background sweep across every category, for UI-freshness only
 * — correctness never depends on this running; createHold's lazy release
 * is the only thing that has to be correct. Safe to call as often as
 * desired (idempotent: a category with no expired holds is a no-op).
 */
export async function sweepExpiredHolds(): Promise<{ categoriesAffected: number }> {
  const result = await prisma.$executeRaw`
    WITH expired AS (
      UPDATE reservations
      SET status = 'expired'
      WHERE status = 'active' AND expires_at < now()
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
