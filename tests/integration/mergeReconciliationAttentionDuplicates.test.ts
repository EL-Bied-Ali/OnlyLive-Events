import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { recordPaymentReconciliationAttention } from "@/lib/orders/checkoutReconciliation";
import {
  findAndMergeDuplicates,
  mergeGroup,
  RECONCILIATION_ATTENTION_ACTION,
} from "../../scripts/mergeReconciliationAttentionDuplicates";

// These rows model what the pre-advisory-lock recordPaymentReconciliationAttention()
// could leave behind under a concurrent read-then-create race: several
// AuditLog rows for the same Payment, each with its own occurrences count
// from repeats that landed on that exact row before it diverged from the
// others. Every test scopes findAndMergeDuplicates() to its own randomly
// generated paymentId via the paymentIds filter, so tests never see or
// mutate each other's rows in this shared, non-isolated test database.
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
  it("keeps the earliest row's id, sums occurrences, and takes firstReason from the earliest row", () => {
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
        id: "row-c-latest-created-but-least-active",
        entityId: "pay-1",
        metadata: { orderId: "order-1", reason: "provider_session_state_ambiguous", observedProviderStatus: "PENDING", occurrences: 1 },
        createdAt: new Date("2026-01-01T00:10:00Z"),
      },
    ];

    const report = mergeGroup("pay-1", rows);

    expect(report.canonicalId).toBe("row-a-earliest");
    expect(report.staleIds.sort()).toEqual(["row-b-middle", "row-c-latest-created-but-least-active"].sort());
    expect(report.mergedMetadata.firstReason).toBe("provider_transaction_lookup_failed");
    expect(report.mergedMetadata.occurrences).toBe(4);
  });

  it("promotes the row with the highest occurrences count to the top-level fields, not the row with the latest createdAt", () => {
    // AuditLog has no updatedAt, and recordPaymentReconciliationAttention()
    // updates an existing row's metadata WITHOUT changing its createdAt. So
    // the earliest-created row (row-a) may in reality have been the one
    // repeatedly updated since — its high occurrences count is the only
    // available signal of that, and createdAt must NOT be used to pick the
    // "current" reason/fields.
    const rows = [
      {
        id: "row-a-earliest-but-most-updated",
        entityId: "pay-2",
        metadata: { reason: "provider_session_state_ambiguous", firstReason: "provider_transaction_lookup_failed", occurrences: 5 },
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      {
        id: "row-b-latest-created-but-never-updated",
        entityId: "pay-2",
        metadata: { reason: "provider_reconciliation_request_failed", occurrences: 1 },
        createdAt: new Date("2026-01-01T00:10:00Z"),
      },
    ];

    const report = mergeGroup("pay-2", rows);

    expect(report.canonicalId).toBe("row-a-earliest-but-most-updated");
    expect(report.mergedMetadata.reason).toBe("provider_session_state_ambiguous");
    expect(report.mergedMetadata.occurrences).toBe(6);
  });

  it("archives every original row's id/createdAt/metadata verbatim, so no diagnostic data is ever destroyed even if the representative-row guess is wrong", () => {
    const rowAMetadata = { reason: "a", firstReason: "a", occurrences: 1 };
    const rowBMetadata = { reason: "b", observedProviderStatus: "PENDING", occurrences: 1 };
    const rows = [
      { id: "row-a", entityId: "pay-3", metadata: rowAMetadata, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "row-b", entityId: "pay-3", metadata: rowBMetadata, createdAt: new Date("2026-01-01T00:01:00Z") },
    ];

    const report = mergeGroup("pay-3", rows);

    expect(report.mergedMetadata.mergedDuplicates).toEqual([
      { id: "row-a", createdAt: "2026-01-01T00:00:00.000Z", metadata: rowAMetadata },
      { id: "row-b", createdAt: "2026-01-01T00:01:00.000Z", metadata: rowBMetadata },
    ]);
  });

  it("uses id as a deterministic tiebreaker for rows with an identical createdAt", () => {
    const rows = [
      { id: "zzz-should-be-second", entityId: "pay-4", metadata: { reason: "z", occurrences: 1 }, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "aaa-should-be-first", entityId: "pay-4", metadata: { reason: "a", occurrences: 1 }, createdAt: new Date("2026-01-01T00:00:00Z") },
    ];

    expect(mergeGroup("pay-4", rows).canonicalId).toBe("aaa-should-be-first");
  });

  it("treats a row missing a numeric occurrences field as exactly one occurrence", () => {
    const rows = [
      { id: "a", entityId: "pay-5", metadata: { reason: "x" }, createdAt: new Date("2026-01-01T00:00:00Z") },
      { id: "b", entityId: "pay-5", metadata: { reason: "y", occurrences: 5 }, createdAt: new Date("2026-01-01T00:01:00Z") },
    ];

    expect(mergeGroup("pay-5", rows).mergedMetadata.occurrences).toBe(6);
  });
});

describe("findAndMergeDuplicates", () => {
  it("dry run reports duplicates but changes nothing, scoped to the given paymentIds", async () => {
    const paymentId = `pay-dryrun-${crypto.randomUUID()}`;
    const rowA = await seedRow(paymentId, { reason: "a", firstReason: "a", occurrences: 1 }, new Date("2026-02-01T00:00:00Z"));
    const rowB = await seedRow(paymentId, { reason: "b", occurrences: 1 }, new Date("2026-02-01T00:05:00Z"));

    const reports = await findAndMergeDuplicates(prisma, { apply: false, paymentIds: [paymentId] });

    expect(reports).toHaveLength(1);
    expect(reports[0]?.canonicalId).toBe(rowA.id);
    expect(reports[0]?.staleIds).toEqual([rowB.id]);

    // Dry run must not have touched the database.
    expect(await prisma.auditLog.count({ where: { entityId: paymentId } })).toBe(2);
    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: rowA.id } })).resolves.toMatchObject({
      metadata: { reason: "a", firstReason: "a", occurrences: 1 },
    });
  });

  it("apply merges the group into the canonical row, archives the originals, and deletes the rest", async () => {
    const paymentId = `pay-apply-${crypto.randomUUID()}`;
    const rowA = await seedRow(paymentId, { orderId: "o-1", reason: "a", firstReason: "a", occurrences: 1 }, new Date("2026-02-02T00:00:00Z"));
    const rowB = await seedRow(paymentId, { orderId: "o-1", reason: "b", occurrences: 2 }, new Date("2026-02-02T00:05:00Z"));
    const rowC = await seedRow(paymentId, { orderId: "o-1", reason: "c", observedProviderStatus: "PENDING", occurrences: 3 }, new Date("2026-02-02T00:10:00Z"));

    await findAndMergeDuplicates(prisma, { apply: true, paymentIds: [paymentId] });

    const remaining = await prisma.auditLog.findMany({ where: { entityId: paymentId } });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]?.id).toBe(rowA.id);
    const metadata = remaining[0]?.metadata as Record<string, unknown>;
    // rowC has the highest occurrences, so its fields are promoted to the top level.
    expect(metadata.reason).toBe("c");
    expect(metadata.observedProviderStatus).toBe("PENDING");
    expect(metadata.firstReason).toBe("a");
    expect(metadata.occurrences).toBe(6);
    expect(metadata.mergedDuplicates).toHaveLength(3);
    await expect(prisma.auditLog.findUnique({ where: { id: rowB.id } })).resolves.toBeNull();
    await expect(prisma.auditLog.findUnique({ where: { id: rowC.id } })).resolves.toBeNull();
  });

  it("never touches a Payment that only has one row", async () => {
    const paymentId = `pay-single-${crypto.randomUUID()}`;
    const row = await seedRow(paymentId, { reason: "only-one", firstReason: "only-one", occurrences: 1 }, new Date());

    const reports = await findAndMergeDuplicates(prisma, { apply: true, paymentIds: [paymentId] });

    expect(reports).toHaveLength(0);
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

    await findAndMergeDuplicates(prisma, { apply: true, paymentIds: [sharedId] });

    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: otherAction.id } })).resolves.toBeTruthy();
    await expect(prisma.auditLog.findUniqueOrThrow({ where: { id: otherEntityType.id } })).resolves.toBeTruthy();
  });

  it("never loses a concurrent recordPaymentReconciliationAttention() observation racing with cleanup", async () => {
    const paymentId = `pay-race-${crypto.randomUUID()}`;
    await seedRow(paymentId, { orderId: "o-race", provider: "charipay", providerPaymentIdPresent: true, reason: "pre-existing-a", firstReason: "pre-existing-a", occurrences: 1 }, new Date("2026-03-01T00:00:00Z"));
    await seedRow(paymentId, { orderId: "o-race", provider: "charipay", providerPaymentIdPresent: true, reason: "pre-existing-b", occurrences: 1 }, new Date("2026-03-01T00:01:00Z"));

    const concurrentObservation = recordPaymentReconciliationAttention(
      { paymentId, orderId: "o-race", provider: "charipay", providerPaymentId: "ps_race" },
      "concurrent_live_observation",
    );
    const cleanup = findAndMergeDuplicates(prisma, { apply: true, paymentIds: [paymentId] });

    await Promise.all([concurrentObservation, cleanup]);

    // Whichever ran first, the shared advisory lock must serialize them so
    // neither silently overwrites the other: exactly one row must remain,
    // and its occurrences must account for all three events (the two
    // pre-existing rows plus the one concurrent call) -- proving the
    // concurrent call's observation was never discarded by a stale-snapshot
    // overwrite.
    const remaining = await prisma.auditLog.findMany({ where: { entityId: paymentId, action: RECONCILIATION_ATTENTION_ACTION } });
    expect(remaining).toHaveLength(1);
    expect((remaining[0]?.metadata as Record<string, unknown>).occurrences).toBe(3);
  });
});
