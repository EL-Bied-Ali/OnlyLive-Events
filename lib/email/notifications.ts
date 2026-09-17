import "server-only";
import type { Prisma, EmailType } from "@prisma/client";

type Tx = Prisma.TransactionClient;

export function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("fr-MA", { style: "currency", currency }).format(cents / 100);
}

/**
 * Enqueues a durable outbox row inside the caller's transaction — the
 * SAME transaction that confirms the underlying business fact (payment
 * webhook, refund). This is what closes the dual-write gap the previous
 * "send after commit" design had: if the process crashes between the
 * business transaction committing and the email being sent, the old
 * design lost the notification silently; here the row is already
 * committed as `pending` and `lib/email/dispatcher.ts` picks it up later,
 * out-of-band, re-rendering content from live state (see the dispatcher —
 * this function never builds subject/text, only queues the *fact* that a
 * notification of this type is owed).
 *
 * `createMany({ skipDuplicates: true })` is the same idempotent-insert
 * idiom as PaymentEvent's `ON CONFLICT DO NOTHING`: a retriggering caller
 * (the same business transition reached again, e.g. a redelivered
 * webhook event that still resolves to a fresh transition) can never
 * enqueue a second row for the same (type, entityType, entityId).
 */
async function enqueue(
  tx: Tx,
  type: EmailType,
  entityType: string,
  entityId: string,
  recipientEmail: string,
): Promise<void> {
  await tx.emailOutbox.createMany({
    data: [{ type, entityType, entityId, recipientEmail }],
    skipDuplicates: true,
  });
}

/**
 * Called from inside the payment webhook's transaction, only when
 * `confirmOrderPayment` returns "paid" in this same call. Only fetches
 * enough to know who to notify — the dispatcher re-fetches the order
 * fresh (and re-validates it's still "paid") before rendering content, so
 * this function is not the source of truth for what the email says.
 */
export async function enqueueOrderConfirmationEmail(tx: Tx, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { user: { select: { email: true } } } });
  if (!order) return;
  await enqueue(tx, "order_confirmation", "order", orderId, order.user.email);
}

export async function enqueuePaymentFailedEmail(tx: Tx, orderId: string): Promise<void> {
  const order = await tx.order.findUnique({ where: { id: orderId }, select: { user: { select: { email: true } } } });
  if (!order) return;
  await enqueue(tx, "payment_failed", "order", orderId, order.user.email);
}

export async function enqueueRefundConfirmationEmail(tx: Tx, refundId: string): Promise<void> {
  const refund = await tx.refund.findUnique({
    where: { id: refundId },
    select: { payment: { select: { order: { select: { user: { select: { email: true } } } } } } },
  });
  if (!refund) return;
  await enqueue(tx, "refund_confirmation", "refund", refundId, refund.payment.order.user.email);
}
