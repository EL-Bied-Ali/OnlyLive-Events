import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { generateValidationToken } from "@/lib/tickets";
import { hashScannedToken, scanTicket } from "@/lib/scanner";
import { createOrderAwaitingPayment, createTestCategory } from "../helpers/fixtures";

async function createScanner(name = "Scanner") {
  return prisma.adminUser.create({
    data: {
      email: `scanner-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-integration-tests",
      name,
      role: "scanner",
    },
  });
}

async function createTicket(status: "valid" | "used" | "cancelled" = "valid") {
  const fixture = await createOrderAwaitingPayment({ quantity: 1 });
  const validationToken = generateValidationToken();
  const ticket = await prisma.ticket.create({
    data: {
      orderItemId: fixture.orderItem.id,
      eventId: fixture.event.id,
      ticketCategoryId: fixture.category.id,
      validationToken,
      status,
      usedAt: status === "used" ? new Date(Date.now() - 60_000) : null,
      attendeeName: "Participant Test",
    },
  });
  return { ...fixture, ticket, validationToken };
}

describe("atomic ticket scanning", () => {
  it("accepts a valid ticket, marks it used, and records the scanner", async () => {
    const [fixture, scanner] = await Promise.all([createTicket(), createScanner()]);

    const result = await scanTicket({
      eventId: fixture.event.id,
      validationToken: fixture.validationToken,
      scannerAdminUserId: scanner.id,
    });

    expect(result.decision).toBe("VALID");
    expect(result.ticket).toMatchObject({
      categoryName: fixture.category.name,
      attendeeName: "Participant Test",
    });

    const [ticket, scan] = await Promise.all([
      prisma.ticket.findUniqueOrThrow({ where: { id: fixture.ticket.id } }),
      prisma.ticketScan.findFirstOrThrow({ where: { ticketId: fixture.ticket.id } }),
    ]);
    expect(ticket.status).toBe("used");
    expect(ticket.usedAt).not.toBeNull();
    expect(scan.result).toBe("valid");
    expect(scan.scannerAdminUserId).toBe(scanner.id);
    expect(scan.scannedToken).toBe(hashScannedToken(fixture.validationToken));
    expect(scan.scannedToken).not.toContain(fixture.validationToken);
  });

  it("returns ALREADY_USED without changing the first admission time", async () => {
    const [fixture, scanner] = await Promise.all([createTicket("used"), createScanner()]);

    const result = await scanTicket({
      eventId: fixture.event.id,
      validationToken: fixture.validationToken,
      scannerAdminUserId: scanner.id,
    });

    expect(result.decision).toBe("ALREADY_USED");
    expect(result.ticket?.firstUsedAt?.getTime()).toBe(fixture.ticket.usedAt?.getTime());
    const scan = await prisma.ticketScan.findFirstOrThrow({ where: { ticketId: fixture.ticket.id } });
    expect(scan.result).toBe("already_used");
  });

  it("records an unknown token as INVALID without storing the bearer token", async () => {
    const [{ event }, scanner] = await Promise.all([createTestCategory(1), createScanner()]);
    const unknownToken = generateValidationToken();

    const result = await scanTicket({
      eventId: event.id,
      validationToken: unknownToken,
      scannerAdminUserId: scanner.id,
    });

    expect(result).toMatchObject({ decision: "INVALID", ticket: null });
    const scan = await prisma.ticketScan.findFirstOrThrow({
      where: { eventId: event.id, scannerAdminUserId: scanner.id },
    });
    expect(scan.ticketId).toBeNull();
    expect(scan.result).toBe("invalid");
    expect(scan.scannedToken).toBe(hashScannedToken(unknownToken));
    expect(scan.scannedToken).not.toContain(unknownToken);
  });

  it("rejects a cancelled ticket and records the decision", async () => {
    const [fixture, scanner] = await Promise.all([createTicket("cancelled"), createScanner()]);

    const result = await scanTicket({
      eventId: fixture.event.id,
      validationToken: fixture.validationToken,
      scannerAdminUserId: scanner.id,
    });

    expect(result.decision).toBe("CANCELLED");
    const scan = await prisma.ticketScan.findFirstOrThrow({ where: { ticketId: fixture.ticket.id } });
    expect(scan.result).toBe("cancelled");
  });

  it("rejects a real ticket presented for the wrong event", async () => {
    const [fixture, otherEventFixture, scanner] = await Promise.all([
      createTicket(),
      createTestCategory(1),
      createScanner(),
    ]);

    const result = await scanTicket({
      eventId: otherEventFixture.event.id,
      validationToken: fixture.validationToken,
      scannerAdminUserId: scanner.id,
    });

    expect(result.decision).toBe("WRONG_EVENT");
    expect(result.ticket).toBeNull();
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.ticket.id } });
    expect(ticket.status).toBe("valid");
    const scan = await prisma.ticketScan.findFirstOrThrow({ where: { ticketId: fixture.ticket.id } });
    expect(scan.result).toBe("wrong_event");
    expect(scan.eventId).toBe(otherEventFixture.event.id);
  });

  it("lets exactly one of two simultaneous scanners admit the same ticket", async () => {
    const fixture = await createTicket();
    const [scannerA, scannerB] = await Promise.all([createScanner("Scanner A"), createScanner("Scanner B")]);

    const results = await Promise.all([
      scanTicket({
        eventId: fixture.event.id,
        validationToken: fixture.validationToken,
        scannerAdminUserId: scannerA.id,
      }),
      scanTicket({
        eventId: fixture.event.id,
        validationToken: fixture.validationToken,
        scannerAdminUserId: scannerB.id,
      }),
    ]);

    expect(results.map((result) => result.decision).sort()).toEqual(["ALREADY_USED", "VALID"]);
    const scans = await prisma.ticketScan.findMany({ where: { ticketId: fixture.ticket.id } });
    expect(scans).toHaveLength(2);
    expect(scans.map((scan) => scan.result).sort()).toEqual(["already_used", "valid"]);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.ticket.id } });
    expect(ticket.status).toBe("used");
  });
});
