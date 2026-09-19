import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import {
  findAndMergeDuplicates,
  mergeGroup,
  RECONCILIATION_ATTENTION_ACTION,
} from "../../scripts/mergeReconciliationAttentionDuplicates";

// These rows model what the pre-advisory-lock recordPaymentReconciliationAttention()
// could leave behind under a concurrent read-then-create race: several
// AuditLog rows for the same Payment, each with its own occurrences count
// from repeats that landed on that exact row before it diverged from the
// others.
async function seedRow(entityId: string, metadata: Record<string, unknown>, createdAt: Date) {
  return prisma.auditLog.create({
    data: {
      actorType: "system",
      action: RECONCILIATION_ATTENTION_ACTION,
      entityType: "Payment",
      entityId,
      metadata: metadata as never,
      createdAt,
    },
  });
}

describe("mergeGroup", () => {
  it("keeps the earliest row's id, sums occurrences, takes firstReason from the earliest and everything else from the latest", () => {
    const rows = [
      {
        id: "row-b-middle",
        entityId: "pay-1",
        metadata: { orderId: "order-1", reason: "provider_transaction_lookup_failed", firstReason: "provider_transaction_lookup_failed", occurrences: 2 },
        createdAt: new Date("2026-01-01T00:05:00Z"),
      },
      {
        id: "row-a-earliest",
        entityId: "pay-1",
        metadata: { orderId: "order-1", reason: "provider_transaction_lookup_failed", firstReason: "provider_transaction_lookup_failed", occurrences: 1 },
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "row-c-latest",
        entityId: "pay-1",
        metadata: { orderId: "order-1", reason: "provider_session_state_ambiguous", observedProviderStatus: "PENDING", occurrences: 1 },
        createdAt: new Date("2026-01-01T00:10:00Z"),
      },
    ];

    const report = mergeGroup("pay-1", rows);

    expect(report.canonicalId).toBe("row-a-earliest");
    expect(report.staleIds.sort()).toEqual(["row-b-middle", "row-c-latest"].sort());
    expect(report.mergedMetadata).toEqual({
      orderId: "order-1",
      reason: "provider_session_state_ambiguous",
      observedProviderStatus: "PENDING",
      firstReason: "provider_transaction_lookup_failed",
      occurrences: 4,
    });
  });

  it("falls back to a row's own reason as firstReason when no row carries an explicit firstReason field", () => {
    const rows = [
      { id: "a", entityId: "pay-2", metadata: { reason: "provider_reference_missing_after_checkout_expiry" }, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "b", entityId: "pay-2", metadata: { reason: "provider_reconciliation_request_failed" }, createdAt: new Date("2026-01-01T00:01:00Z") },
    ];

    const report = mergeGroup("pay-2", rows);

    expect(report.mergedMetadata.firstReason).toBe("provider_reference_missing_after_checkout_expiry");
    expect(report.mergedMetadata.reason).toBe("provider_reconciliation_request_failed");
    expect(report.mergedMetadata.occurrences).toBe(2);
  });

  it("treats a row missing a numeric occurrences field as exactly one occurrence", () => {
    const rows = [
      { id: "a", entityId: "pay-3", metadata: { reason: "x" }, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "b", entityId: "pay-3", metadata: { reason: "y", occurrences: 5 }, createdAt: new Date("2026-01-01T00:01:00Z") },
    ];

    expect(mergeGroup("pay-3", rows).mergedMetadata.occurrences).toBe(6);
  });
});

describe("findAndMergeDuplicates", () => {
  it("dry run reports duplicates but changes nothing", async () => {
    const paymentId = `pay-dryrun-${crypto.randomUUID()}`;
    const rowA = await seedRow(paymentId, { reason: "a", firstReason: "a", occurrences: 1 }, new Date("2026-02-01T00:00:00Z"));
    const rowB = await seedRow(paymentId, { reason: "b", occurrences: 1 }, new Date("2026-02-01T00:05:00Z"));

    const reports = await findAndMergeDuplicates(prisma, { apply: false });
    const forThisPayment = reports.find((report) => report.paymentId === paymentId);

    expect(forThisPayment).toBeDefined();
    expect(forThisPayment?.canonicalId).toBe(rowA.id);
    expect(forThisPayment?.staleIds).toEqual([rowB.id]);

    // Dry run must not have touched the database.
    expect(await prisma.auditLog.count({ where: { entityId: paymentId } })).toBe(2);
    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: rowA.id } })).resolves.toMatchObject({
      metadata: { reason: "a", firstReason: "a", occurrences: 1 },
    });
  });

  it("apply merges the group into the canonical row and deletes the rest", async () => {
    const paymentId = `pay-apply-${crypto.randomUUID()}`;
    const rowA = await seedRow(paymentId, { orderId: "o-1", reason: "a", firstReason: "a", occurrences: 1 }, new Date("2026-02-02T00:00:00Z"));
    const rowB = await seedRow(paymentId, { orderId: "o-1", reason: "b", occurrences: 2 }, new Date("2026-02-02T00:05:00Z"));
    const rowC = await seedRow(paymentId, { orderId: "o-1", reason: "c", observedProviderStatus: "PENDING", occurrences: 1 }, new Date("2026-02-02T00:10:00Z"));

    await findAndMergeDuplicates(prisma, { apply: true });

    const remaining = await prisma.auditLog.findMany({ where: { entityId: paymentId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(rowA.id);
    expect(remaining[0]?.metadata).toEqual({
      orderId: "o-1",
      reason: "c",
      observedProviderStatus: "PENDING",
      firstReason: "a",
      occurrences: 4,
    });
    await expect(prisma.auditLog.findUnique({ where: { id: rowB.id } })).resolves.toBeNull();
    await expect(prisma.auditLog.findUnique({ where: { id: rowC.id } })).resolves.toBeNull();
  });

  it("never touches a Payment that only has one row", async () => {
    const paymentId = `pay-single-${crypto.randomUUID()}`;
    const row = await seedRow(paymentId, { reason: "only-one", firstReason: "only-one", occurrences: 1 }, new Date());

    const reports = await findAndMergeDuplicates(prisma, { apply: true });

    expect(reports.some((report) => report.paymentId === paymentId)).toBe(false);
    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: row.id } })).resolves.toMatchObject({
      metadata: { reason: "only-one", firstReason: "only-one", occurrences: 1 },
    });
  });

  it("never touches rows for a different action or entity type, even for the same entityId", async () => {
    const sharedId = `shared-${crypto.randomUUID()}`;
    const otherAction = await prisma.auditLog.create({
      data: {
        actorType: "system",
        action: "payment.webhook_header_status_mismatch",
        entityType: "Payment",
        entityId: sharedId,
        metadata: { note: "unrelated action" } as never,
      },
    });
    const otherEntityType = await prisma.auditLog.create({
      data: {
        actorType: "system",
        action: RECONCILIATION_ATTENTION_ACTION,
        entityType: "Order",
        entityId: sharedId,
        metadata: { note: "unrelated entity type" } as never,
      },
    });

    await findAndMergeDuplicates(prisma, { apply: true });

    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: otherAction.id } })).resolves.toBeTruthy();
    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: otherEntityType.id } })).resolves.toBeTruthy();
  });
});
