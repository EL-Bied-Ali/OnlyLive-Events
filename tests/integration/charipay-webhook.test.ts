import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { initiateRefund } from "@/lib/orders/refund";
import { POST as chariWebhookPost } from "@/app/api/payments/webhook/charipay/route";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

const WEBHOOK_SECRET = "charipay-integration-webhook-secret";

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "webhook", "integration"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
  vi.stubEnv("VERCEL_ENV", "preview");
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

  return new NextRequest("https://preview.onlylive.example/api/payments/webhook/charipay", {
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
  const providerPaymentId = `ps_${crypto.randomUUID()}`;
  const payment = await prisma.payment.update({
    where: { id: fixture.payment.id },
    data: { provider: "charipay", providerPaymentId },
  });
  return { ...fixture, payment };
}

function paymentPayload(paymentId: string, providerPaymentId: string, amountCents: number, currency = "MAD") {
  return {
    externalId: paymentId,
    sessionId: providerPaymentId,
    amount: amountCents / 100,
    currency,
    metadata: { onlylivePaymentId: paymentId },
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
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.payment.providerPaymentId!, fixture.payment.amountCents),
      "payment.succeeded",
      crypto.randomUUID(),
      "0".repeat(64),
    ));
    expect(response.status).toBe(401);
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    expect(await prisma.paymentEvent.count({ where: { paymentId: fixture.payment.id } })).toBe(0);
  });

  it("fails closed on a correctly signed but incomplete payload", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      { externalId: fixture.payment.id, sessionId: fixture.payment.providerPaymentId },
      "payment.succeeded",
    ));
    expect(response.status).toBe(400);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("processes payment.succeeded exactly once and detects same-event-id content collision", async () => {
    const fixture = await createChariPendingOrder({ quantity: 2, priceCents: 12_500 });
    enableChariPay();
    const eventId = crypto.randomUUID();
    const payload = paymentPayload(fixture.payment.id, fixture.payment.providerPaymentId!, fixture.payment.amountCents);

    const first = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ ok: true, outcome: "paid" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(2);

    const duplicate = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const collision = await chariWebhookPost(signedRequest(
      { ...payload, metadata: { onlylivePaymentId: fixture.payment.id, changed: true } },
      "payment.succeeded",
      eventId,
    ));
    expect(collision.status).toBe(409);
    await expect(collision.json()).resolves.toMatchObject({ error: "EVENT_COLLISION" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(2);
  });

  it("rejects a validly signed payment amount mismatch", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.payment.providerPaymentId!, fixture.payment.amountCents + 100),
      "payment.succeeded",
    ));
    expect(response.status).toBe(409);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("rejects signed refund amount, currency, and payment-reference mismatches before finalization", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    expect((await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.payment.providerPaymentId!, fixture.payment.amountCents),
      "payment.succeeded",
    ))).status).toBe(200);

    const admin = await createAdmin();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_integrity", state: "processing" });
    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Integrity test",
      actorId: admin.id,
    });

    const base = {
      externalId: fixture.payment.id,
      sessionId: fixture.payment.providerPaymentId,
      refundId: "rf_integrity",
      refundReference: initiated.refundId,
      refundAmount: fixture.payment.amountCents / 100,
      currency: "MAD",
    };
    for (const payload of [
      { ...base, refundAmount: base.refundAmount + 1 },
      { ...base, currency: "EUR" },
      { ...base, externalId: crypto.randomUUID() },
      { ...base, sessionId: "ps_wrong" },
      { ...base, refundId: "rf_wrong" },
    ]) {
      const response = await chariWebhookPost(signedRequest(payload, "refund.succeeded"));
      expect(response.status).toBe(409);
      await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing" });
    }
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
  });

  it("applies a signed refund.succeeded exactly once without double-releasing inventory", async () => {
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 10_000 });
    enableChariPay();
    expect((await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.payment.providerPaymentId!, fixture.payment.amountCents),
      "payment.succeeded",
    ))).status).toBe(200);

    const admin = await createAdmin();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_webhook_1", state: "processing" });
    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Full async refund",
      actorId: admin.id,
    });
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    const refundPayload = {
      externalId: fixture.payment.id,
      sessionId: fixture.payment.providerPaymentId,
      refundId: "rf_webhook_1",
      refundReference: initiated.refundId,
      refundAmount: fixture.payment.amountCents / 100,
      currency: fixture.payment.currency,
    };
    const eventId = crypto.randomUUID();

    const succeeded = await chariWebhookPost(signedRequest(refundPayload, "refund.succeeded", eventId));
    expect(succeeded.status).toBe(200);
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "succeeded" });
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 1);

    const duplicate = await chariWebhookPost(signedRequest(refundPayload, "refund.succeeded", eventId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });
    const inventoryAfterDuplicate = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfterDuplicate.soldQuantity).toBe(inventoryAfter.soldQuantity);
  });
});
