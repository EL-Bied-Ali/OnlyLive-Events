import "dotenv/config";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * Before lib/orders/checkoutReconciliation.ts's recordPaymentReconciliationAttention()
 * gained its advisory-transaction lock, concurrent writers could each pass a
 * read-then-create race and leave more than one `payment.checkout_reconciliation_required`
 * AuditLog row for the same Payment. The lock prevents new duplicates going
 * forward but never touches historical ones — see GitHub issue #44.
 *
 * findAndMergeDuplicates() finds any such pre-existing duplicate groups and
 * merges each group into one canonical row.
 *
 * Two correctness constraints drive the design (found in cold audit of the
 * first version of this script):
 *
 * 1. `AuditLog` has no `updatedAt`, and recordPaymentReconciliationAttention()
 *    updates an existing row's metadata WITHOUT changing its `createdAt`. So
 *    `createdAt` cannot reliably identify which row in a duplicate group holds
 *    the most current diagnostics — an earliest-created row can have been
 *    updated many times since. Rather than guess and risk silently discarding
 *    a real observation, every original row's id/createdAt/metadata is
 *    archived verbatim into the canonical row's `mergedDuplicates` field
 *    before any row is deleted. The top-level `reason`/extra fields are only
 *    a best-effort convenience view (highest `occurrences`, tiebroken by
 *    latest `createdAt`); the archive is the actual source of truth and nothing
 *    is ever destroyed.
 * 2. The merge-and-delete for one Payment must not race a concurrent
 *    recordPaymentReconciliationAttention() call for the same Payment (which
 *    would otherwise let this script's update silently overwrite a fresh
 *    observation). Applying a group therefore takes the exact same
 *    `payment-reconciliation-attention:<paymentId>` advisory transaction lock
 *    that helper uses, then re-reads the rows fresh inside that lock — never
 *    trusting the earlier candidate-scan snapshot for the actual mutation.
 *
 * Defaults to a dry run that only reports what it would do (using the
 * candidate scan directly — safe to be a stale preview since nothing is
 * written). Pass apply:true to actually merge and delete; each Payment is
 * merged in its own locked transaction so one bad group can't roll back
 * every other group's cleanup, and a group that turns out to no longer be a
 * duplicate by the time the lock is acquired is left untouched.
 */

export const RECONCILIATION_ATTENTION_ACTION = "payment.checkout_reconciliation_required";
const ENTITY_TYPE = "Payment";

interface AuditRow {
  id: string;
  entityId: string;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

export interface DuplicateGroupReport {
  paymentId: string;
  canonicalId: string;
  staleIds: string[];
  mergedMetadata: Record<string, Prisma.JsonValue>;
}

function asMetadataObject(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : {};
}

function occurrencesOf(metadata: Record<string, Prisma.JsonValue>): number {
  const value = metadata.occurrences;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : 1;
}

/** Deterministic ascending order: createdAt first, id as a tiebreaker for equal timestamps. */
function byCreatedAtThenId(a: AuditRow, b: AuditRow): number {
  const byTime = a.createdAt.getTime() - b.createdAt.getTime();
  if (byTime !== 0) return byTime;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function mergeGroup(paymentId: string, rows: AuditRow[]): DuplicateGroupReport {
  const sorted = [...rows].sort(byCreatedAtThenId);
  const canonical = sorted[0]!;

  // Best-effort "most representative of current state" row: the one that has
  // been written to the most times is the best available proxy for recency
  // given AuditLog has no updatedAt — but this only picks which fields are
  // promoted to the top level. The full archive below is what actually
  // guarantees no data is lost regardless of whether this guess is right.
  const mostActive = [...sorted].sort((a, b) => {
    const byOccurrences = occurrencesOf(asMetadataObject(a.metadata)) - occurrencesOf(asMetadataObject(b.metadata));
    if (byOccurrences !== 0) return byOccurrences;
    return byCreatedAtThenId(a, b);
  })[sorted.length - 1]!;

  let firstReason: Prisma.JsonValue | undefined;
  let occurrencesSum = 0;
  for (const row of sorted) {
    const metadata = asMetadataObject(row.metadata);
    if (firstReason === undefined) {
      const candidate = metadata.firstReason ?? metadata.reason;
      if (typeof candidate === "string") firstReason = candidate;
    }
    occurrencesSum += occurrencesOf(metadata);
  }

  const representativeMetadata = asMetadataObject(mostActive.metadata);
  const mergedMetadata: Record<string, Prisma.JsonValue> = {
    ...representativeMetadata,
    ...(firstReason !== undefined ? { firstReason } : {}),
    occurrences: occurrencesSum,
    mergedDuplicates: sorted.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      metadata: row.metadata,
    })),
  };

  return {
    paymentId,
    canonicalId: canonical.id,
    mergedMetadata,
    staleIds: sorted.slice(1).map((row) => row.id),
  };
}

async function findCandidatePaymentIds(
  client: PrismaClient,
  paymentIds?: string[],
): Promise<string[]> {
  const rows = await client.auditLog.findMany({
    where: {
      action: RECONCILIATION_ATTENTION_ACTION,
      entityType: ENTITY_TYPE,
      ...(paymentIds ? { entityId: { in: paymentIds } } : {}),
    },
    select: { entityId: true },
  });

  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.entityId, (counts.get(row.entityId) ?? 0) + 1);
  return [...counts.entries()].filter(([, count]) => count > 1).map(([paymentId]) => paymentId);
}

async function previewGroup(client: PrismaClient, paymentId: string): Promise<DuplicateGroupReport | null> {
  const rows = await client.auditLog.findMany({
    where: { action: RECONCILIATION_ATTENTION_ACTION, entityType: ENTITY_TYPE, entityId: paymentId },
    select: { id: true, entityId: true, metadata: true, createdAt: true },
  });
  if (rows.length < 2) return null;
  return mergeGroup(paymentId, rows);
}

/**
 * Applies one Payment's merge under the same advisory lock
 * recordPaymentReconciliationAttention() uses, re-reading fresh rows inside
 * that lock so a concurrent observation can never be silently overwritten.
 * Returns null if the group no longer has a duplicate by the time the lock
 * is acquired (already resolved by a prior run, or was never really a
 * duplicate to begin with).
 */
async function applyGroup(client: PrismaClient, paymentId: string): Promise<DuplicateGroupReport | null> {
  return client.$transaction(async (tx) => {
    const lockKey = `payment-reconciliation-attention:${paymentId}`;
    await tx.$queryRaw<Array<{ locked: boolean }>>`
      SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0)) IS NULL AS locked
    `;

    const rows = await tx.auditLog.findMany({
      where: { action: RECONCILIATION_ATTENTION_ACTION, entityType: ENTITY_TYPE, entityId: paymentId },
      select: { id: true, entityId: true, metadata: true, createdAt: true },
    });
    if (rows.length < 2) return null;

    const report = mergeGroup(paymentId, rows);
    await tx.auditLog.update({
      where: { id: report.canonicalId },
      data: { metadata: report.mergedMetadata as Prisma.InputJsonObject },
    });
    await tx.auditLog.deleteMany({ where: { id: { in: report.staleIds } } });
    return report;
  });
}

export async function findAndMergeDuplicates(
  client: PrismaClient,
  options: { apply: boolean; paymentIds?: string[] },
): Promise<DuplicateGroupReport[]> {
  const candidatePaymentIds = await findCandidatePaymentIds(client, options.paymentIds);

  const reports: DuplicateGroupReport[] = [];
  for (const paymentId of candidatePaymentIds) {
    const report = options.apply
      ? await applyGroup(client, paymentId)
      : await previewGroup(client, paymentId);
    if (report) reports.push(report);
  }

  return reports;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const reports = await findAndMergeDuplicates(prisma, { apply });

  if (reports.length === 0) {
    console.log(`No duplicate ${RECONCILIATION_ATTENTION_ACTION} rows found. Nothing to do.`);
    return;
  }

  console.log(`Found ${reports.length} Payment(s) with duplicate ${RECONCILIATION_ATTENTION_ACTION} rows.`);
  for (const report of reports) {
    console.log(
      `\nPayment ${report.paymentId}: keeping ${report.canonicalId}, deleting ${report.staleIds.join(", ")}`,
    );
    console.log(`  merged metadata: ${JSON.stringify(report.mergedMetadata)}`);
  }

  console.log(apply ? "\nApplied." : "\nDry run only -- no rows changed. Re-run with --apply to merge and delete.");
}

const isMainModule = process.argv[1] !== undefined
  && fileURLToPath(import.meta.url) === resolve(process.argv[1]);

if (isMainModule) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
