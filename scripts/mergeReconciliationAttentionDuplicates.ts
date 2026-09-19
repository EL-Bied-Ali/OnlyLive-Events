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
 * merges each group into the single canonical row the locked implementation
 * would have produced: the earliest row's id is kept, `firstReason` is the
 * earliest non-null reason across the group, `occurrences` is the sum across
 * the group (each row's own occurrences already reflects repeats that landed
 * on that exact row before it diverged), and every other field — including
 * `reason` and any call-site-specific diagnostic fields — comes from
 * whichever row in the group has the latest `createdAt`, matching the
 * "latest wins" semantics the locked helper already uses for a single row.
 *
 * Defaults to a dry run that only reports what it would do. Pass apply:true
 * to actually update the canonical row and delete the redundant ones. Each
 * group is merged in its own transaction so one bad group can't roll back
 * every other group's cleanup.
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

export function mergeGroup(paymentId: string, rows: AuditRow[]): DuplicateGroupReport {
  const sorted = [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const canonical = sorted[0]!;
  const latest = sorted[sorted.length - 1]!;

  let firstReason: Prisma.JsonValue | undefined;
  let occurrencesSum = 0;
  for (const row of sorted) {
    const metadata = asMetadataObject(row.metadata);
    if (firstReason === undefined) {
      const candidate = metadata.firstReason ?? metadata.reason;
      if (typeof candidate === "string") firstReason = candidate;
    }
    const occurrences = metadata.occurrences;
    occurrencesSum += typeof occurrences === "number" && Number.isSafeInteger(occurrences) && occurrences >= 1
      ? occurrences
      : 1;
  }

  const latestMetadata = asMetadataObject(latest.metadata);
  const mergedMetadata: Record<string, Prisma.JsonValue> = {
    ...latestMetadata,
    ...(firstReason !== undefined ? { firstReason } : {}),
    occurrences: occurrencesSum,
  };

  return {
    paymentId,
    canonicalId: canonical.id,
    mergedMetadata,
    staleIds: sorted.slice(1).map((row) => row.id),
  };
}

export async function findAndMergeDuplicates(
  client: PrismaClient,
  options: { apply: boolean },
): Promise<DuplicateGroupReport[]> {
  const rows = await client.auditLog.findMany({
    where: { action: RECONCILIATION_ATTENTION_ACTION, entityType: ENTITY_TYPE },
    select: { id: true, entityId: true, metadata: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  const byPaymentId = new Map<string, AuditRow[]>();
  for (const row of rows) {
    const group = byPaymentId.get(row.entityId) ?? [];
    group.push(row);
    byPaymentId.set(row.entityId, group);
  }

  const reports: DuplicateGroupReport[] = [];
  for (const [paymentId, group] of byPaymentId.entries()) {
    if (group.length < 2) continue;
    const report = mergeGroup(paymentId, group);
    reports.push(report);

    if (!options.apply) continue;

    await client.$transaction(async (tx) => {
      await tx.auditLog.update({
        where: { id: report.canonicalId },
        data: { metadata: report.mergedMetadata as Prisma.InputJsonObject },
      });
      await tx.auditLog.deleteMany({ where: { id: { in: report.staleIds } } });
    });
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
