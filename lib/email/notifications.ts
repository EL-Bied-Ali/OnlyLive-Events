import "server-only";
import crypto from "node:crypto";
import { prisma } from "@/lib/db";
import { getEmailProvider } from "@/lib/email";
import type { EmailType } from "@prisma/client";

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("fr-MA", { style: "currency", currency }).format(cents / 100);
}

/**
 * Claims (type, entityType, entityId) via the same INSERT ... ON CONFLICT
 * DO NOTHING RETURNING id idempotency idiom as payment_events, then sends.
 * A caller retriggering this for an order/refund that already got its
 * email (e.g. the webhook route being invoked again for an unrelated
 * reason) is a safe no-op — the claim simply finds nothing to insert.
 *
 * A send failure is logged, never thrown: email delivery must never roll
 * back or block the business transaction that triggered it (payment
 * confirmation, refund). The claim row is left in place either way —
 * retrying a *failed* send isn't done by calling this again (that would
 * see the existing claim and no-op); it would need a background retry
 * job, not yet built (see TASKS.md).
 */
async function claimAndSend(
  type: EmailType,
  entityType: string,
  entityId: string,
  recipientEmail: string,
  subject: string,
  text: string,
): Promise<void> {
  const claimId = crypto.randomUUID();
  const claimed = await prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO email_logs (id, type, entity_type, entity_id, recipient_email)
    VALUES (${claimId}, ${type}::"EmailType", ${entityType}, ${entityId}, ${recipientEmail})
    ON CONFLICT (type, entity_type, entity_id) DO NOTHING
    RETURNING id
  `;
  if (claimed.length === 0) {
    return;
  }

  try {
    const result = await getEmailProvider().send({ to: recipientEmail, subject, text });
    await prisma.emailLog.update({ where: { id: claimId }, data: { providerMessageId: result.providerMessageId } });
  } catch (error) {
    console.error(`Failed to send ${type} email for ${entityType}/${entityId}`, error);
  }
}

/**
 * Order confirmation + payment confirmation + ticket delivery, sent as
 * one email — in this system all three become true at the same instant
 * (the order transitions to "paid" and its tickets are generated in the
 * same database transaction), so splitting them into separate messages
 * would only fragment one event into three without adding information.
 */
export async function sendOrderConfirmationEmail(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { email: true, name: true } },
      event: { select: { title: true } },
      items: {
        include: {
          ticketCategory: { select: { name: true } },
          tickets: { select: { id: true } },
        },
      },
    },
  });
  if (!order) return;

  const ticketLines = order.items.flatMap((item) =>
    item.tickets.map((ticket) => `- ${item.ticketCategory.name}: /orders/${order.id}/tickets/${ticket.id}`),
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

  await claimAndSend(
    "order_confirmation",
    "order",
    order.id,
    order.user.email,
    `Confirmation de commande ${order.orderNumber}`,
    text,
  );
}

export async function sendPaymentFailedEmail(orderId: string): Promise<void> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { user: { select: { email: true, name: true } }, event: { select: { title: true } } },
  });
  if (!order) return;

  const text = [
    `Bonjour ${order.user.name ?? ""},`.trim(),
    "",
    `Le paiement de votre commande ${order.orderNumber} pour ${order.event.title} n'a pas abouti.`,
    "Aucun montant n'a été débité. Vous pouvez réessayer depuis votre compte.",
    "",
    "— OnlyLive",
  ].join("\n");

  await claimAndSend(
    "payment_failed",
    "order",
    order.id,
    order.user.email,
    `Échec du paiement — commande ${order.orderNumber}`,
    text,
  );
}

export async function sendRefundConfirmationEmail(refundId: string): Promise<void> {
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
  if (!refund) return;

  const order = refund.payment.order;
  const text = [
    `Bonjour ${order.user.name ?? ""},`.trim(),
    "",
    `Un remboursement de ${money(refund.amountCents, refund.payment.currency)} a été émis pour votre commande ${order.orderNumber} (${order.event.title}).`,
    `Motif : ${refund.reason}`,
    "",
    "— OnlyLive",
  ].join("\n");

  await claimAndSend(
    "refund_confirmation",
    "refund",
    refund.id,
    order.user.email,
    `Remboursement — commande ${order.orderNumber}`,
    text,
  );
}
