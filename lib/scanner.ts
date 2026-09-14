import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import type { ScanResult, TicketStatus } from "@prisma/client";

export type ScannerDecision = "VALID" | "ALREADY_USED" | "INVALID" | "CANCELLED" | "REFUND_PENDING" | "WRONG_EVENT";

interface TicketLookupRow {
  id: string;
  orderId: string;
}

interface LockedTicketRow {
  id: string;
  orderId: string;
  eventId: string;
  status: TicketStatus;
  usedAt: Date | null;
  attendeeName: string | null;
  categoryName: string;
}

interface ScanTicketInput {
  eventId: string;
  validationToken: string;
  scannerAdminUserId: string;
}

export interface ScanTicketResult {
  decision: ScannerDecision;
  scannedAt: Date;
  ticket: {
    categoryName: string;
    attendeeName: string | null;
    firstUsedAt: Date | null;
  } | null;
}

const DATABASE_RESULT: Record<ScannerDecision, ScanResult> = {
  VALID: "valid",
  ALREADY_USED: "already_used",
  INVALID: "invalid",
  CANCELLED: "cancelled",
  // ScanResult predates async refunds; persist this financial denial in the
  // non-entry bucket while the API exposes the more precise decision.
  REFUND_PENDING: "cancelled",
  WRONG_EVENT: "wrong_event",
};

export function hashScannedToken(validationToken: string): string {
  return `sha256:${crypto.createHash("sha256").update(validationToken).digest("hex")}`;
}

/**
 * Decide and persist one scan in a single PostgreSQL transaction.
 *
 * Lock order for known tickets is Order -> Ticket. Refund initiation/finalize
 * also serializes through the Order before ticket cancellation, preventing a
 * full-refund-processing race from admitting a new scan without introducing
 * a Ticket<->Order deadlock.
 */
export async function scanTicket(input: ScanTicketInput): Promise<ScanTicketResult> {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: input.eventId }, select: { id: true } });
    if (!event) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }

    const lookup = await tx.$queryRaw<TicketLookupRow[]>`
      SELECT t.id, oi.order_id AS "orderId"
      FROM tickets t
      INNER JOIN order_items oi ON oi.id = t.order_item_id
      WHERE t.validation_token = ${input.validationToken}
    `;
    const known = lookup[0] ?? null;
    if (known) {
      await tx.$queryRaw`SELECT id FROM orders WHERE id = ${known.orderId} FOR UPDATE`;
    }

    const tickets = await tx.$queryRaw<LockedTicketRow[]>`
      SELECT
        t.id,
        oi.order_id AS "orderId",
        t.event_id AS "eventId",
        t.status,
        t.used_at AS "usedAt",
        t.attendee_name AS "attendeeName",
        tc.name AS "categoryName"
      FROM tickets t
      INNER JOIN order_items oi ON oi.id = t.order_item_id
      INNER JOIN ticket_categories tc ON tc.id = t.ticket_category_id
      WHERE t.validation_token = ${input.validationToken}
      FOR UPDATE OF t
    `;

    const ticket = tickets[0] ?? null;
    let decision: ScannerDecision;

    if (!ticket) {
      decision = "INVALID";
    } else if (ticket.eventId !== input.eventId) {
      decision = "WRONG_EVENT";
    } else if (ticket.status === "cancelled") {
      decision = "CANCELLED";
    } else if (ticket.status === "used") {
      decision = "ALREADY_USED";
    } else {
      const payment = await tx.payment.findFirst({
        where: { orderId: ticket.orderId },
        orderBy: { createdAt: "asc" },
        select: { id: true, amountCents: true },
      });
      if (payment) {
        const committedRefunds = await tx.refund.aggregate({
          where: { paymentId: payment.id, status: { in: ["processing", "succeeded"] } },
          _sum: { amountCents: true },
        });
        const committed = committedRefunds._sum.amountCents ?? 0;
        decision = committed >= payment.amountCents ? "REFUND_PENDING" : "VALID";
      } else {
        decision = "VALID";
      }
    }

    const scannedAt = new Date();
    if (decision === "VALID" && ticket) {
      const updated = await tx.ticket.updateMany({
        where: { id: ticket.id, status: "valid" },
        data: { status: "used", usedAt: scannedAt },
      });
      if (updated.count !== 1) {
        throw new Error("Locked valid ticket could not be marked used");
      }
    }

    await tx.ticketScan.create({
      data: {
        ticketId: ticket?.id ?? null,
        scannedToken: hashScannedToken(input.validationToken),
        scannerAdminUserId: input.scannerAdminUserId,
        eventId: input.eventId,
        result: DATABASE_RESULT[decision],
        scannedAt,
      },
    });

    return {
      decision,
      scannedAt,
      ticket: ticket && decision !== "WRONG_EVENT"
        ? {
            categoryName: ticket.categoryName,
            attendeeName: ticket.attendeeName,
            firstUsedAt: decision === "VALID" ? scannedAt : ticket.usedAt,
          }
        : null,
    };
  });
}
