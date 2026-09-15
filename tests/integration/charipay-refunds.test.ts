import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { ChariPayProvider } from "@/lib/payments/chariPayProvider";
import { POST as fakeWebhookPost } from "@/app/api/payments/webhook/fake/route";
import {
  finalizeRefundSuccess,
  initiateRefund,
  reconcileProcessingRefunds,
} from "@/lib/orders/refund";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function fakeWebhookRequest(payload: unknown) {
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

async function createPaidOrderForChariPay(options: { quantity?: number; priceCents?: number } = {}) {
  const fixture = await createOrderAwaitingPayment(options);
  const response = await fakeWebhookPost(
    fakeWebhookRequest({
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
    }),
  );
  expect(response.status).toBe(200);

  await prisma.payment.update({
    where: { id: fixture.payment.id },
    data: { provider: "charipay", providerPaymentId: `ps_${crypto.randomUUID()}` },
  });
  return fixture;
}

async function createAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `charipay-refund-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: "ChariPay Refund Admin",
      role: "admin",
    },
  });
}

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_API_KEY", "chari_sk_test_onlylive_integration");
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "integration-webhook-secret");
}

describe("ChariPay asynchronous refund lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("does not change paid order/tickets/inventory until the async refund is confirmed", async () => {
    const fixture = await createPaidOrderForChariPay({ quantity: 2, priceCents: 10_000 });
    const admin = await createAdmin();
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({
      providerRefundId: "crf_pending_1",
      status: "pending",
    });

    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 20_000,
      reason: "Async full refund",
      actorId: admin.id,
    });
    expect(initiated.status).toBe("processing");
    expect(initiated.paymentStatus).toBe("paid");
    expect(initiated.orderStatus).toBe("paid");

    const processing = await prisma.refund.findFirstOrThrow({ where: { paymentId: fixture.payment.id } });
    expect(processing.status).toBe("processing");
    expect(processing.providerRefundId).toBe("crf_pending_1");

    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "paid" });
    const ticketsBefore = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(ticketsBefore).toHaveLength(2);
    expect(ticketsBefore.every((ticket) => ticket.status === "valid")).toBe(true);
    const inventoryWhilePending = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryWhilePending.soldQuantity).toBe(inventoryBefore.soldQuantity);

    const finalized = await finalizeRefundSuccess(processing.id, "crf_pending_1");
    expect(finalized.paymentStatus).toBe("refunded");
    expect(finalized.orderStatus).toBe("refunded");

    const ticketsAfter = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(ticketsAfter.every((ticket) => ticket.status === "cancelled")).toBe(true);
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 2);
  });

  it("reserves refundable balance while a ChariPay refund is still processing", async () => {
    const fixture = await createPaidOrderForChariPay({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({
      providerRefundId: "crf_pending_balance",
      status: "pending",
    });

    const first = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 7_000,
      reason: "First async refund",
      actorId: admin.id,
    });
    expect(first.status).toBe("processing");

    await expect(
      initiateRefund({
        paymentId: fixture.payment.id,
        amountCents: 4_000,
        reason: "Would over-refund",
        actorId: admin.id,
      }),
    ).rejects.toMatchObject({ code: "REFUND_EXCEEDS_REMAINING", status: 409 });

    const processingTotal = await prisma.refund.aggregate({
      where: { paymentId: fixture.payment.id, status: "processing" },
      _sum: { amountCents: true },
    });
    expect(processingTotal._sum.amountCents).toBe(7_000);
  });

  it("housekeeping finalizes a processing refund when provider status says SUCCESS", async () => {
    const fixture = await createPaidOrderForChariPay({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({
      providerRefundId: "crf_reconcile_success",
      status: "pending",
    });
    vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({
      providerRefundId: "crf_reconcile_success",
      status: "succeeded",
    });

    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "Webhook loss fallback",
      actorId: admin.id,
    });
    await prisma.refund.update({
      where: { id: initiated.refundId },
      data: { updatedAt: new Date(Date.now() - 60_000) },
    });

    const summary = await reconcileProcessingRefunds();
    expect(summary).toMatchObject({ checked: 1, succeeded: 1, errors: 0 });
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "refunded" });
  });

  it("replays the exact same refundReference when status lookup says not_found", async () => {
    const fixture = await createPaidOrderForChariPay({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    const refundSpy = vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({
      providerRefundId: "same-refund-reference",
      status: "pending",
    });
    vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({
      providerRefundId: "same-refund-reference",
      status: "not_found",
    });

    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "Ambiguous first submission",
      actorId: admin.id,
    });
    await prisma.refund.update({
      where: { id: initiated.refundId },
      data: { providerRefundId: null, updatedAt: new Date(Date.now() - 60_000) },
    });

    const summary = await reconcileProcessingRefunds();
    expect(summary).toMatchObject({ checked: 1, replayedMissing: 1, pending: 1, errors: 0 });
    expect(refundSpy).toHaveBeenCalledTimes(2);
    expect(refundSpy.mock.calls[0]![0].idempotencyKey).toBe(initiated.refundId);
    expect(refundSpy.mock.calls[1]![0].idempotencyKey).toBe(initiated.refundId);
  });
});
