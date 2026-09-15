import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { FakeProvider, signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { POST as fakeWebhookPost } from "@/app/api/payments/webhook/fake/route";
import { finalizeRefundFailure, finalizeRefundSuccess, initiateRefund } from "@/lib/orders/refund";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function webhookRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  return new NextRequest("http://localhost/api/payments/webhook/fake", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onlylive-fake-signature": signFakeWebhookPayload(body),
    },
    body,
  });
}

async function paidFixture(priceCents = 10_000) {
  const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents });
  const response = await fakeWebhookPost(webhookRequest({
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type: "payment.succeeded",
    amountCents: fixture.payment.amountCents,
    currency: fixture.payment.currency,
  }));
  expect(response.status).toBe(200);
  const admin = await prisma.adminUser.create({
    data: {
      email: `async-refund-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: "Async Refund Admin",
      role: "admin",
    },
  });
  return { ...fixture, admin };
}

describe("asynchronous refund settlement", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps money, tickets and inventory unchanged while the PSP refund is processing", async () => {
    const fixture = await paidFixture();
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    vi.spyOn(FakeProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "provider-refund-pending", state: "processing" });

    const result = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "async provider",
      actorId: fixture.admin.id,
    });
    expect(result).toMatchObject({ state: "processing" });

    const refund = await prisma.refund.findUniqueOrThrow({ where: { id: result.refundId } });
    expect(refund).toMatchObject({ status: "processing", providerRefundId: "provider-refund-pending" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "paid" });
    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets.every((ticket) => ticket.status === "valid")).toBe(true);
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity);
  });

  it("reserves pending refund balance so concurrent submissions cannot over-refund", async () => {
    const fixture = await paidFixture();
    vi.spyOn(FakeProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "pending-a", state: "processing" });

    const first = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 7_000,
      reason: "first",
      actorId: fixture.admin.id,
    });
    expect(first.state).toBe("processing");

    await expect(initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 4_000,
      reason: "would exceed remaining",
      actorId: fixture.admin.id,
    })).rejects.toMatchObject({ code: "REFUND_EXCEEDS_REMAINING", status: 409 });
  });

  it("applies ticket and financial state only after success confirmation, exactly once", async () => {
    const fixture = await paidFixture();
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    vi.spyOn(FakeProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "pending-success", state: "processing" });
    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "settle later",
      actorId: fixture.admin.id,
    });

    const first = await finalizeRefundSuccess(initiated.refundId, "pending-success");
    expect(first).toMatchObject({ changed: true, paymentStatus: "refunded", orderStatus: "refunded" });
    const second = await finalizeRefundSuccess(initiated.refundId, "pending-success");
    expect(second.changed).toBe(false);

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets.every((ticket) => ticket.status === "cancelled")).toBe(true);
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 1);
  });

  it("a provider failure frees reserved refund balance for a later retry", async () => {
    const fixture = await paidFixture();
    vi.spyOn(FakeProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "pending-fail", state: "processing" });
    const first = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "first",
      actorId: fixture.admin.id,
    });

    expect((await finalizeRefundFailure(first.refundId, "pending-fail")).changed).toBe(true);
    expect((await finalizeRefundFailure(first.refundId, "pending-fail")).changed).toBe(false);

    const retry = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "retry",
      actorId: fixture.admin.id,
    });
    expect(retry.state).toBe("processing");
    expect(retry.refundId).not.toBe(first.refundId);
  });
});
