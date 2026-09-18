import "server-only";
import { prisma } from "@/lib/db";
import type { OrderStatus, Prisma } from "@prisma/client";

const ATTENTION_STATUSES: OrderStatus[] = ["paid_but_unfulfillable", "reconciliation_required"];

export async function getAdminMetrics() {
  const now = new Date();
  const [paidPayments, ticketsSold, checkIns, awaitingPayment, attentionOrders] = await Promise.all([
    prisma.payment.aggregate({ where: { status: "paid" }, _sum: { amountCents: true } }),
    prisma.ticket.count(),
    prisma.ticket.count({ where: { status: "used" } }),
    prisma.order.count({ where: { status: "pending_payment" } }),
    // Unresolved provider-backed financial work must remain visible even after
    // the initiating admin/customer leaves the page. A processing refund is a
    // reserved money operation whose final outcome is not known yet; failed
    // refunds and expired-but-unresolved hosted checkouts also require review.
    // One order is counted once even if several attention conditions apply.
    prisma.order.count({
      where: {
        OR: [
          { status: { in: ATTENTION_STATUSES } },
          { status: "pending_payment", expiresAt: { lt: now } },
          { payments: { some: { refunds: { some: { status: { in: ["processing", "failed"] } } } } } },
        ],
      },
    }),
  ]);

  return {
    grossCapturedCents: paidPayments._sum.amountCents ?? 0,
    ticketsSold,
    checkIns,
    awaitingPayment,
    attentionOrders,
  };
}

export async function getAdminOverview() {
  const [metrics, recentOrders, events] =
    await Promise.all([
      getAdminMetrics(),
      prisma.order.findMany({
        take: 8,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { name: true, email: true } },
          event: { select: { title: true } },
        },
      }),
      prisma.event.findMany({
        orderBy: { startsAt: "asc" },
        include: {
          venue: { select: { name: true, city: true } },
          ticketCategories: {
            include: { inventory: true },
            orderBy: { sortOrder: "asc" },
          },
        },
      }),
    ]);

  return {
    metrics,
    recentOrders,
    events,
  };
}

export async function getAdminOrders(status?: OrderStatus) {
  return prisma.order.findMany({
    where: status ? { status } : undefined,
    take: 100,
    orderBy: { createdAt: "desc" },
    include: {
      user: { select: { name: true, email: true, phone: true } },
      event: { select: { title: true } },
      items: {
        include: { ticketCategory: { select: { name: true } } },
      },
      payments: {
        orderBy: { createdAt: "desc" },
        select: { provider: true },
      },
    },
  });
}

const EXPORT_BATCH_SIZE = 1_000;

const exportOrderInclude = {
  user: { select: { name: true, email: true, phone: true } },
  event: { select: { title: true } },
  items: { include: { ticketCategory: { select: { name: true } } } },
  payments: { orderBy: { createdAt: "desc" }, select: { provider: true } },
} satisfies Prisma.OrderInclude;

export type OrderForExport = Prisma.OrderGetPayload<{ include: typeof exportOrderInclude }>;

/**
 * Same filter as getAdminOrders but without its 100-row display cap.
 * Results are yielded in deterministic (createdAt DESC, id DESC) keyset
 * order so same-millisecond orders cannot be duplicated or skipped at a
 * batch boundary. The cursor is internal-only and always comes from the
 * previous fetched batch.
 */
export async function* iterateOrdersForExport(
  status?: OrderStatus,
  batchSize: number = EXPORT_BATCH_SIZE,
): AsyncGenerator<OrderForExport[]> {
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new Error("Export batch size must be a positive integer");
  }

  let cursorId: string | undefined;
  for (;;) {
    const batch = await prisma.order.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: batchSize,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      include: exportOrderInclude,
    });

    if (batch.length === 0) return;
    yield batch;
    if (batch.length < batchSize) return;
    cursorId = batch[batch.length - 1]!.id;
  }
}

export async function getOrderForAdmin(orderId: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      user: { select: { name: true, email: true, phone: true } },
      event: { select: { title: true } },
      items: {
        include: {
          ticketCategory: { select: { name: true } },
          tickets: { select: { id: true, status: true, validationToken: true } },
        },
      },
      payments: {
        orderBy: { createdAt: "desc" },
        include: {
          refunds: { orderBy: { createdAt: "desc" } },
        },
      },
    },
  });
  if (!order) return null;

  const paymentsWithRefundable = order.payments.map((payment) => {
    const refundedCents = payment.refunds
      .filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const committedRefundCents = payment.refunds
      .filter((refund) => refund.status === "processing" || refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    return {
      ...payment,
      refundedCents,
      committedRefundCents,
      remainingRefundableCents: Math.max(0, payment.amountCents - committedRefundCents),
    };
  });

  return { ...order, payments: paymentsWithRefundable };
}

export function isOrderStatus(value: string | undefined): value is OrderStatus {
  return [
    "pending_payment",
    "paid",
    "failed",
    "cancelled",
    "refunded",
    "partially_refunded",
    "paid_but_unfulfillable",
    "reconciliation_required",
  ].includes(value ?? "");
}
