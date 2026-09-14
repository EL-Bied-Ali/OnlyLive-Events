import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import { absoluteAppUrl } from "@/lib/appUrl";
import { money } from "@/lib/email/notifications";
import type { EmailOutbox } from "@prisma/client";

const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 30_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;
/** A row stuck in `processing` longer than this is assumed to belong to a crashed/killed worker and is reclaimed. */
const LEASE_TIMEOUT_MS = 5 * 60 * 1000;
/**
 * Overridable via env for tests: the shared, non-isolated integration test
 * database can accumulate a large backlog of pending rows left behind by
 * unrelated test files that trigger a payment webhook but never call
 * dispatchPendingEmails(). A small fixed batch size would let that backlog
 * crowd out a test's own row (ORDER BY next_attempt_at ASC). Production
 * keeps the default of 20 per invocation.
 */
const BATCH_SIZE = Number(process.env.EMAIL_DISPATCH_BATCH_SIZE) || 20;

function backoffMs(attemptCount: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** attemptCount, MAX_BACKOFF_MS);
  return exponential + Math.floor(Math.random() * 1000);
}

/** Never put a raw recipient address in logs — a short, non-reversible fingerprint is enough to correlate log lines with a support ticket. */
function hashRecipient(email: string): string {
  return crypto.createHash("sha256").update(email).digest("hex").slice(0, 12);
}

/** Never log a raw error object (may embed a future real provider's response body) or the email body — only a short, bounded code. */
function errorCode(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 200);
  return "unknown_error";
}

interface RenderedEmail {
  subject: string;
  text: string;
}

/**
 * Business-state validation: re-checks the entity is still in the state
 * that justifies this email's content, using data fetched fresh at
 * dispatch time — never trusting that the state at enqueue time still
 * holds. Returns null when it no longer does (e.g. the order state
 * changed for some other reason before this row was dispatched); the
 * caller marks the row terminally `failed` with a distinguishing
 * `lastErrorCode` rather than sending stale/incorrect content.
 */
async function renderOrderConfirmation(orderId: string): Promise<RenderedEmail | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { email: true, name: true } },
      event: { select: { title: true } },
      items: { include: { ticketCategory: { select: { name: true } }, tickets: { select: { id: true } } } },
    },
  });
  if (!order || order.status !== "paid") return null;

  const ticketLines = order.items.flatMap((item) =>
    item.tickets.map(
      (ticket) => `- ${item.ticketCategory.name}: ${absoluteAppUrl(`/orders/${order.id}/tickets/${ticket.id}`)}`,
    ),
  );

  const text = [
    `Bonjour ${order.user.name ?? ""},`.trim(),
    "",
    `Votre commande ${order.orderNumber} pour ${order.event.title} est confirmée.`,
    `Total payé : ${money(order.totalAmountCents, order.currency)}`,
    "",
    "Vos billets :",
    ...ticketLines,
    "",
    "— OnlyLive",
  ].join("\n");

  return { subject: `Confirmation de commande ${order.orderNumber}`, text };
}

async function renderPaymentFailed(orderId: string): Promise<RenderedEmail | null> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: { select: { email: true, name: true } }, event: { select: { title: true } } },
  });
  if (!order || (order.status !== "failed" && order.status !== "cancelled")) return null;

  const text = [
    `Bonjour ${order.user.name ?? ""},`.trim(),
    "",
    `Le paiement de votre commande ${order.orderNumber} pour ${order.event.title} n'a pas abouti.`,
    "Aucun montant n'a été débité. Vous pouvez réessayer depuis votre compte.",
    "",
    "— OnlyLive",
  ].join("\n");

  return { subject: `Échec du paiement — commande ${order.orderNumber}`, text };
}

async function renderRefundConfirmation(refundId: string): Promise<RenderedEmail | null> {
  const refund = await prisma.refund.findUnique({
    where: { id: refundId },
    include: {
      payment: {
        include: {
          order: { include: { user: { select: { email: true, name: true } }, event: { select: { title: true } } } },
        },
      },
    },
  });
  if (!refund || refund.status !== "succeeded") return null;

  const order = refund.payment.order;
  const text = [
    `Bonjour ${order.user.name ?? ""},`.trim(),
    "",
    `Un remboursement de ${money(refund.amountCents, refund.payment.currency)} a été émis pour votre commande ${order.orderNumber} (${order.event.title}).`,
    // refund.reason is an admin-entered note (see lib/orders/refund.ts) —
    // it may describe internal handling, not something written for the
    // customer to read, so it is deliberately never included here.
    "",
    "— OnlyLive",
  ].join("\n");

  return { subject: `Remboursement — commande ${order.orderNumber}`, text };
}

async function renderEmail(row: Pick<EmailOutbox, "type" | "entityId">): Promise<RenderedEmail | null> {
  switch (row.type) {
    case "order_confirmation":
      return renderOrderConfirmation(row.entityId);
    case "payment_failed":
      return renderPaymentFailed(row.entityId);
    case "refund_confirmation":
      return renderRefundConfirmation(row.entityId);
  }
}

/**
 * Atomically claims a batch of due rows: `pending` rows whose
 * `nextAttemptAt` has arrived, or `processing` rows whose lease expired
 * (a crashed worker never finished them). `FOR UPDATE SKIP LOCKED` lets
 * multiple concurrent dispatcher invocations (e.g. overlapping cron
 * triggers) each get a disjoint batch instead of double-processing the
 * same rows or blocking on each other.
 */
async function claimBatch(): Promise<EmailOutbox[]> {
  const leaseCutoff = new Date(Date.now() - LEASE_TIMEOUT_MS);
  return prisma.$transaction(async (tx) => {
    const claimable = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM email_outbox
      WHERE (status = 'pending' AND next_attempt_at <= now())
         OR (status = 'processing' AND processing_started_at < ${leaseCutoff})
      ORDER BY next_attempt_at ASC
      LIMIT ${BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    `;
    if (claimable.length === 0) return [];

    const ids = claimable.map((row) => row.id);
    await tx.emailOutbox.updateMany({
      where: { id: { in: ids } },
      data: { status: "processing", processingStartedAt: new Date() },
    });
    return tx.emailOutbox.findMany({ where: { id: { in: ids } } });
  });
}

export interface DispatchSummary {
  claimed: number;
  sent: number;
  retried: number;
  permanentlyFailed: number;
  skipped: number;
}

/**
 * Invoked by the authenticated internal endpoint
 * (app/api/internal/dispatch-emails/route.ts), the same pattern as
 * sweepExpiredHolds — meant to run on a schedule. Each claimed row is
 * rendered fresh and sent independently: one row's provider failure
 * never blocks another's, and no database transaction spans the
 * provider's network call.
 */
export async function dispatchPendingEmails(): Promise<DispatchSummary> {
  const rows = await claimBatch();
  const summary: DispatchSummary = { claimed: rows.length, sent: 0, retried: 0, permanentlyFailed: 0, skipped: 0 };

  for (const row of rows) {
    const rendered = await renderEmail(row);
    if (!rendered) {
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: { status: "failed", lastErrorCode: "entity_state_no_longer_valid" },
      });
      summary.skipped += 1;
      continue;
    }

    try {
      const result = await getEmailProvider().send({
        to: row.recipientEmail,
        subject: rendered.subject,
        text: rendered.text,
        idempotencyKey: row.id,
      });
      await prisma.emailOutbox.update({
        where: { id: row.id },
        data: { status: "sent", sentAt: new Date(), providerMessageId: result.providerMessageId, lastErrorCode: null },
      });
      summary.sent += 1;
    } catch (error) {
      const nextAttemptCount = row.attemptCount + 1;
      const code = errorCode(error);
      console.error(
        `[email:dispatch] send failed type=${row.type} outboxId=${row.id} recipientHash=${hashRecipient(row.recipientEmail)} attempt=${nextAttemptCount} error=${code}`,
      );

      if (nextAttemptCount >= MAX_ATTEMPTS) {
        await prisma.emailOutbox.update({
          where: { id: row.id },
          data: { status: "failed", attemptCount: nextAttemptCount, lastErrorCode: code },
        });
        summary.permanentlyFailed += 1;
      } else {
        await prisma.emailOutbox.update({
          where: { id: row.id },
          data: {
            status: "pending",
            attemptCount: nextAttemptCount,
            nextAttemptAt: new Date(Date.now() + backoffMs(nextAttemptCount)),
            lastErrorCode: code,
          },
        });
        summary.retried += 1;
      }
    }
  }

  return summary;
}
