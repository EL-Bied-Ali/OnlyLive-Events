import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { getAdminMetrics, getOrderForAdmin } from "@/lib/admin/dashboard";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

async function createAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `refund-attention-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used",
      name: "Refund Attention Admin",
      role: "admin",
    },
  });
}

describe("admin async-refund visibility", () => {
  it("reserves processing refunds from the displayed refundable balance and releases failed ones", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "paid" } });
    await prisma.payment.update({ where: { id: fixture.payment.id }, data: { status: "paid" } });

    const refund = await prisma.refund.create({
      data: {
        paymentId: fixture.payment.id,
        amountCents: 4_000,
        reason: "Provider confirmation pending",
        status: "processing",
        initiatedByAdminUserId: admin.id,
      },
    });

    const pending = await getOrderForAdmin(fixture.order.id);
    const pendingPayment = pending?.payments.find((payment) => payment.id === fixture.payment.id);
    expect(pendingPayment).toMatchObject({
      refundedCents: 0,
      committedRefundCents: 4_000,
      remainingRefundableCents: 6_000,
    });

    await prisma.refund.update({ where: { id: refund.id }, data: { status: "failed" } });
    const failed = await getOrderForAdmin(fixture.order.id);
    const failedPayment = failed?.payments.find((payment) => payment.id === fixture.payment.id);
    expect(failedPayment).toMatchObject({
      refundedCents: 0,
      committedRefundCents: 0,
      remainingRefundableCents: 10_000,
    });
  });

  it("keeps an order with a failed async refund in the admin attention count", async () => {
    const before = await getAdminMetrics();
    const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 9_000 });
    const admin = await createAdmin();
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "paid" } });
    await prisma.payment.update({ where: { id: fixture.payment.id }, data: { status: "paid" } });
    await prisma.refund.create({
      data: {
        paymentId: fixture.payment.id,
        amountCents: 9_000,
        reason: "Provider declined asynchronously",
        status: "failed",
        initiatedByAdminUserId: admin.id,
      },
    });

    const after = await getAdminMetrics();
    expect(after.attentionOrders).toBe(before.attentionOrders + 1);
  });
});
