import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { generateValidationToken } from "@/lib/tickets";
import { hashScannedToken, scanTicket } from "@/lib/scanner";
import { initiateRefund } from "@/lib/orders/refund";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
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

async function createRefundAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `refund-scanner-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-integration-tests",
      name: "Refund Scanner Admin",
      role: "admin",
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

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "scanner", "refund"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "scanner-refund-webhook-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
  vi.stubEnv("VERCEL_ENV", "preview");
}

async function waitForProcessingRefund(paymentId: string) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const refund = await prisma.refund.findFirst({ where: { paymentId, status: "processing" } });
    if (refund) return refund;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Refund did not reach durable processing state");
}

describe("atomic ticket scanning", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("accepts a valid ticket, marks it used, and records the scanner", async () => {
    const [fixture, scanner] = await Promise.all([createTicket(), createScanner()]);
    const result = await scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scanner.id });
    expect(result.decision).toBe("VALID");
    expect(result.ticket).toMatchObject({ categoryName: fixture.category.name, attendeeName: "Participant Test" });

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
    const result = await scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scanner.id });
    expect(result.decision).toBe("ALREADY_USED");
    expect(result.ticket?.firstUsedAt?.getTime()).toBe(fixture.ticket.usedAt?.getTime());
    const scan = await prisma.ticketScan.findFirstOrThrow({ where: { ticketId: fixture.ticket.id } });
    expect(scan.result).toBe("already_used");
  });

  it("records an unknown token as INVALID without storing the bearer token", async () => {
    const [{ event }, scanner] = await Promise.all([createTestCategory(1), createScanner()]);
    const unknownToken = generateValidationToken();
    const result = await scanTicket({ eventId: event.id, validationToken: unknownToken, scannerAdminUserId: scanner.id });
    expect(result).toMatchObject({ decision: "INVALID", ticket: null });
    const scan = await prisma.ticketScan.findFirstOrThrow({ where: { eventId: event.id, scannerAdminUserId: scanner.id } });
    expect(scan.ticketId).toBeNull();
    expect(scan.result).toBe("invalid");
    expect(scan.scannedToken).toBe(hashScannedToken(unknownToken));
    expect(scan.scannedToken).not.toContain(unknownToken);
  });

  it("rejects a cancelled ticket and records the decision", async () => {
    const [fixture, scanner] = await Promise.all([createTicket("cancelled"), createScanner()]);
    const result = await scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scanner.id });
    expect(result.decision).toBe("CANCELLED");
    const scan = await prisma.ticketScan.findFirstOrThrow({ where: { ticketId: fixture.ticket.id } });
    expect(scan.result).toBe("cancelled");
  });

  it("rejects a real ticket presented for the wrong event", async () => {
    const [fixture, otherEventFixture, scanner] = await Promise.all([createTicket(), createTestCategory(1), createScanner()]);
    const result = await scanTicket({ eventId: otherEventFixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scanner.id });
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
      scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scannerA.id }),
      scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scannerB.id }),
    ]);
    expect(results.map((result) => result.decision).sort()).toEqual(["ALREADY_USED", "VALID"]);
    const scans = await prisma.ticketScan.findMany({ where: { ticketId: fixture.ticket.id } });
    expect(scans).toHaveLength(2);
    expect(scans.map((scan) => scan.result).sort()).toEqual(["already_used", "valid"]);
    const ticket = await prisma.ticket.findUniqueOrThrow({ where: { id: fixture.ticket.id } });
    expect(ticket.status).toBe("used");
  });

  it("blocks a new scan once a full refund is durably processing, even while the provider call is still in flight", async () => {
    enableChariPay();
    const fixture = await createTicket();
    const [scanner, admin] = await Promise.all([createScanner(), createRefundAdmin()]);
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "paid" } });
    await prisma.payment.update({
      where: { id: fixture.payment.id },
      data: { status: "paid", provider: "charipay", providerPaymentId: `ps_${crypto.randomUUID()}` },
    });

    let resolveProvider!: (value: { providerRefundId: string; state: "processing" }) => void;
    vi.spyOn(ChariPayProvider.prototype, "refund").mockImplementation(() => new Promise((resolve) => { resolveProvider = resolve; }));

    const refundPromise = initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Concurrent full refund",
      actorId: admin.id,
    });
    const processing = await waitForProcessingRefund(fixture.payment.id);

    const scan = await scanTicket({
      eventId: fixture.event.id,
      validationToken: fixture.validationToken,
      scannerAdminUserId: scanner.id,
    });
    expect(scan.decision).toBe("REFUND_PENDING");
    await expect(prisma.ticket.findUniqueOrThrow({ where: { id: fixture.ticket.id } })).resolves.toMatchObject({ status: "valid" });

    resolveProvider({ providerRefundId: `rf_${processing.id}`, state: "processing" });
    await expect(refundPromise).resolves.toMatchObject({ refundId: processing.id, state: "processing" });
  });

  it("allows scanning again if the pending full refund later fails", async () => {
    const [fixture, scanner, admin] = await Promise.all([createTicket(), createScanner(), createRefundAdmin()]);
    await prisma.refund.create({
      data: {
        paymentId: fixture.payment.id,
        amountCents: fixture.payment.amountCents,
        reason: "Temporary provider failure",
        status: "processing",
        initiatedByAdminUserId: admin.id,
      },
    });

    const blocked = await scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scanner.id });
    expect(blocked.decision).toBe("REFUND_PENDING");
    await prisma.refund.updateMany({ where: { paymentId: fixture.payment.id }, data: { status: "failed" } });

    const allowed = await scanTicket({ eventId: fixture.event.id, validationToken: fixture.validationToken, scannerAdminUserId: scanner.id });
    expect(allowed.decision).toBe("VALID");
  });
});
