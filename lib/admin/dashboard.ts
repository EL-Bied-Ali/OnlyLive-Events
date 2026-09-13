import "server-only";
import { prisma } from "@/lib/db";
import type { OrderStatus } from "@prisma/client";

const ATTENTION_STATUSES: OrderStatus[] = ["paid_but_unfulfillable", "reconciliation_required"];

export async function getAdminMetrics() {
  const [paidPayments, ticketsSold, checkIns, awaitingPayment, attentionOrders] = await Promise.all([
    prisma.payment.aggregate({ where: { status: "paid" }, _sum: { amountCents: true } }),
    prisma.ticket.count(),
    prisma.ticket.count({ where: { status: "used" } }),
    prisma.order.count({ where: { status: "pending_payment" } }),
    prisma.order.count({ where: { status: { in: ATTENTION_STATUSES } } }),
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
