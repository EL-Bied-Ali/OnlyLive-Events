import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ChariPayProvider } from "@/lib/payments/chariPayProvider";
import { initiateRefund } from "@/lib/orders/refund";
import { POST as chariWebhookPost } from "@/app/api/payments/webhook/charipay/route";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

const WEBHOOK_SECRET = "charipay-integration-webhook-secret";

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_API_KEY", "chari_sk_test_onlylive_webhook_integration");
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
}

function signedRequest(
  payload: unknown,
  type: "payment.succeeded" | "payment.failed" | "refund.succeeded" | "refund.failed",
  eventId = crypto.randomUUID(),
  signatureOverride?: string,
) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = signatureOverride ?? crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  return new NextRequest("https://tickets.onlylive.ma/api/payments/webhook/charipay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chari-signature": signature,
      "x-chari-timestamp": timestamp,
      "chari-event-id": eventId,
      "chari-event-type": type,
    },
    body: rawBody,
  });
}

async function createChariPendingOrder(options: { quantity?: number; priceCents?: number } = {}) {
  const fixture = await createOrderAwaitingPayment(options);
  await prisma.payment.update({
    where: { id: fixture.payment.id },
    data: { provider: "charipay", providerPaymentId: `ps_${crypto.randomUUID()}` },
  });
  return fixture;
}

function paymentPayload(paymentId: string, amountCents: number, currency = "MAD") {
  return {
    externalId: paymentId,
    amount: amountCents / 100,
    currency,
    metadata: {
      onlyLivePaymentId: paymentId,
      onlyLiveAmountCents: amountCents,
      onlyLiveCurrency: currency,
    },
  };
}

async function createAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `charipay-webhook-admin-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: "ChariPay Webhook Admin",
      role: "admin",
    },
  });
}

describe("ChariPay webhook route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects an invalid signature before mutating payment/order state", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();

    const response = await chariWebhookPost(
      signedRequest(
        paymentPayload(fixture.payment.id, fixture.payment.amountCents),
        "payment.succeeded",
        crypto.randomUUID(),
        "0".repeat(64),
      ),
    );
    expect(response.status).toBe(401);

    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "awaiting_payment" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    expect(await prisma.paymentEvent.count({ where: { paymentId: fixture.payment.id } })).toBe(0);
  });

  it("processes a signed payment.succeeded once and deduplicates the same Chari event id", async () => {
    const fixture = await createChariPendingOrder({ quantity: 2, priceCents: 12_500 });
    enableChariPay();
    const eventId = crypto.randomUUID();
    const payload = paymentPayload(fixture.payment.id, fixture.payment.amountCents);

    const first = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ ok: true, outcome: "paid" });

    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(2);

    const duplicate = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(2);
    expect(await prisma.paymentEvent.count({ where: { paymentId: fixture.payment.id, provider: "charipay" } })).toBe(1);
  });

  it("rejects a validly signed amount mismatch without issuing tickets", async () => {
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 10_000 });
    enableChariPay();
    const payload = paymentPayload(fixture.payment.id, fixture.payment.amountCents + 100);

    const response = await chariWebhookPost(signedRequest(payload, "payment.succeeded"));
    expect(response.status).toBe(409);
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("applies a signed refund.succeeded exactly once after an async refund request", async () => {
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 10_000 });
    enableChariPay();

    const paid = await chariWebhookPost(
      signedRequest(paymentPayload(fixture.payment.id, fixture.payment.amountCents), "payment.succeeded"),
    );
    expect(paid.status).toBe(200);

    const admin = await createAdmin();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({
      providerRefundId: "crf_webhook_1",
      status: "pending",
    });
    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Full async refund",
      actorId: admin.id,
    });
    expect(initiated.status).toBe("processing");

    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    const refundPayload = {
      externalId: fixture.payment.id,
      refundReference: initiated.refundId,
      refundAmount: fixture.payment.amountCents / 100,
      currency: fixture.payment.currency,
      metadata: {
        onlyLivePaymentId: fixture.payment.id,
        onlyLiveRefundId: initiated.refundId,
        onlyLiveAmountCents: fixture.payment.amountCents,
        onlyLiveCurrency: fixture.payment.currency,
      },
    };
    const eventId = crypto.randomUUID();

    const succeeded = await chariWebhookPost(signedRequest(refundPayload, "refund.succeeded", eventId));
    expect(succeeded.status).toBe(200);
    await expect(succeeded.json()).resolves.toMatchObject({ ok: true, outcome: "refund.succeeded" });

    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "refunded" });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "refunded" });
    const ticket = await prisma.ticket.findFirstOrThrow({ where: { orderItemId: fixture.orderItem.id } });
    expect(ticket.status).toBe("cancelled");
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 1);

    const duplicate = await chariWebhookPost(signedRequest(refundPayload, "refund.succeeded", eventId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });
    const inventoryAfterDuplicate = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfterDuplicate.soldQuantity).toBe(inventoryAfter.soldQuantity);
  });
});
