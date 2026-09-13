import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import type { ScanResult, TicketStatus } from "@prisma/client";

export type ScannerDecision = "VALID" | "ALREADY_USED" | "INVALID" | "CANCELLED" | "WRONG_EVENT";

interface LockedTicketRow {
  id: string;
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
  WRONG_EVENT: "wrong_event",
};

/**
 * Ticket validation tokens are bearer credentials. TicketScan keeps only a
 * one-way digest so an operational/audit table leak cannot create usable QR
 * copies. Known tickets remain correlatable through ticketId.
 */
export function hashScannedToken(validationToken: string): string {
  return `sha256:${crypto.createHash("sha256").update(validationToken).digest("hex")}`;
}

/**
 * Decide and persist one scan in a single PostgreSQL transaction. The ticket
 * row is locked before reading its status; two scanners racing on the same QR
 * therefore serialize, and exactly one can transition valid -> used.
 */
export async function scanTicket(input: ScanTicketInput): Promise<ScanTicketResult> {
  return prisma.$transaction(async (tx) => {
    const event = await tx.event.findUnique({ where: { id: input.eventId }, select: { id: true } });
    if (!event) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }

    const tickets = await tx.$queryRaw<LockedTicketRow[]>`
      SELECT
        t.id,
        t.event_id AS "eventId",
        t.status,
        t.used_at AS "usedAt",
        t.attendee_name AS "attendeeName",
        tc.name AS "categoryName"
      FROM tickets t
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
      decision = "VALID";
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
