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

// Matches a real signed sandbox delivery for payment.succeeded (captured
// 2026-09-17 via ChariPay's partner webhook-events API). ChariPay's own
// generated fields are PascalCased; ExternalId/Reference/CustomData all
// carry the ORDER id (not the payment id), and there is no sessionId or
// currency field at all — see charipayProvider.ts's parseWebhook.
function paymentPayload(paymentId: string, orderId: string, amountCents: number) {
  return {
    Amount: amountCents / 100,
    ExternalId: orderId,
    Reference: orderId,
    CustomData: orderId,
    metadata: { onlylivePaymentId: paymentId, onlyliveOrderId: orderId },
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
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
      crypto.randomUUID(),
      "0".repeat(64),
    ));
    expect(response.status).toBe(401);
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    expect(await prisma.paymentEvent.count({ where: { paymentId: fixture.payment.id } })).toBe(0);
  });

  it("acknowledges a signed synthetic ChariPay test without mutating financial state", async () => {
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      { Test: true },
      "payment.succeeded",
      `test-${crypto.randomUUID()}`,
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, test: true });
  });

  it("processes a historical ChariPay payment after the default provider changes", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    vi.stubEnv("PAYMENT_PROVIDER", "fake");

    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
    ));

    expect(response.status).toBe(200);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({
      provider: "charipay",
      status: "paid",
    });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(1);
  });

  it("fails closed on a correctly signed but incomplete payload", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      { ExternalId: fixture.order.id, Reference: fixture.order.id },
      "payment.succeeded",
    ));
    expect(response.status).toBe(400);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("processes payment.succeeded exactly once and detects same-event-id content collision", async () => {
    const fixture = await createChariPendingOrder({ quantity: 2, priceCents: 12_500 });
    enableChariPay();
    const eventId = crypto.randomUUID();
    const payload = paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents);

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

  it("resolves the payment via metadata.onlylivePaymentId, even though ExternalId/Reference/CustomData are actually the order id", async () => {
    // The exact, real-world confusing case that broke the original
    // parser: a real ChariPay delivery's ExternalId/Reference/CustomData
    // all carry OnlyLive's ORDER id, not the Payment id — despite
    // createPayment() sending `externalId: input.paymentId`. Only
    // metadata.onlylivePaymentId (echoed back verbatim from our own
    // request) reliably resolves the Payment row.
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 8_500 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest({
      Amount: fixture.payment.amountCents / 100,
      ExternalId: fixture.order.id,
      Reference: fixture.order.id,
      CustomData: fixture.order.id,
      metadata: { onlylivePaymentId: fixture.payment.id, onlyliveOrderId: fixture.order.id },
    }, "payment.succeeded"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "paid" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(1);
  });

  it("rejects a validly signed payment amount mismatch", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents + 100),
      "payment.succeeded",
    ));
    expect(response.status).toBe(409);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("acknowledges every signed refund event with 202 and never finalizes, regardless of payload correctness", async () => {
    // Refund webhook field-name casing has not been confirmed against a
    // real signed delivery (only payment.succeeded has), so
    // CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED gates all refund.* events
    // closed before any matching/mismatch logic runs — see route.ts. A
    // well-formed, correctly-matching payload and a wrong-amount/
    // wrong-reference payload must be indistinguishable here: both get
    // acknowledged for manual reconciliation, neither ever finalizes.
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    expect((await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
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
      RefundId: "rf_integrity",
      RefundAmount: fixture.payment.amountCents / 100,
      metadata: { onlyliveRefundId: initiated.refundId, onlylivePaymentId: fixture.payment.id },
    };
    for (const type of ["refund.succeeded", "refund.failed"] as const) {
      for (const payload of [
        base,
        { ...base, RefundAmount: base.RefundAmount + 1 },
        { ...base, metadata: { ...base.metadata, onlylivePaymentId: crypto.randomUUID() } },
        { ...base, RefundId: "rf_wrong" },
      ]) {
        const response = await chariWebhookPost(signedRequest(payload, type, crypto.randomUUID()));
        expect(response.status).toBe(202);
        await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
        await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing" });
      }
    }
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    expect(await prisma.auditLog.count({
      where: { action: "refund.webhook_shape_unverified" },
    })).toBeGreaterThanOrEqual(8);
  });

  it("acknowledges an authentic provider refund that has no local Refund row without ever looking it up", async () => {
    enableChariPay();
    const unknownReference = crypto.randomUUID();
    const eventId = crypto.randomUUID();
    const response = await chariWebhookPost(signedRequest({
      metadata: { onlyliveRefundId: unknownReference },
      RefundId: `rf_${crypto.randomUUID()}`,
      RefundAmount: 10,
    }, "refund.succeeded", eventId));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
    // The shape-unverified gate short-circuits before the old
    // refund-lookup path, so the legacy "refund.provider_unknown" audit
    // action (which requires reaching prisma.refund.findUnique) is never
    // written for this event — only the gate's own action is.
    expect(await prisma.auditLog.count({
      where: { action: "refund.provider_unknown", entityId: unknownReference },
    })).toBe(0);
    // entityId is always the fixed string "charipay" for every gate hit, so
    // scope by this event's own externalEventId (unique per call) rather
    // than by action+entityId, which would also match unrelated rows from
    // other tests/deliveries in this shared persistent database.
    expect(await prisma.auditLog.count({
      where: { action: "refund.webhook_shape_unverified", metadata: { path: ["externalEventId"], equals: eventId } },
    })).toBe(1);
  });

  it("never finalizes a well-formed refund.succeeded webhook, even when local ids are absent", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    expect((await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
    ))).status).toBe(200);

    const admin = await createAdmin();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: null, state: "processing" });
    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Optional provider ids",
      actorId: admin.id,
    });

    const response = await chariWebhookPost(signedRequest({
      metadata: { onlyliveRefundId: initiated.refundId },
      RefundAmount: fixture.payment.amountCents / 100,
    }, "refund.succeeded"));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing" });
  });

  it("never releases inventory from a refund.succeeded webhook, not even on repeated delivery", async () => {
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 10_000 });
    enableChariPay();
    expect((await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
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
      metadata: { onlyliveRefundId: initiated.refundId, onlylivePaymentId: fixture.payment.id },
      RefundId: "rf_webhook_1",
      RefundAmount: fixture.payment.amountCents / 100,
    };
    const eventId = crypto.randomUUID();

    const first = await chariWebhookPost(signedRequest(refundPayload, "refund.succeeded", eventId));
    expect(first.status).toBe(202);
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing" });
    const inventoryAfterFirst = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfterFirst.soldQuantity).toBe(inventoryBefore.soldQuantity);

    // Same externalEventId delivered twice: the shape-unverified gate runs
    // before the duplicate/event-collision check, so this is not exercising
    // idempotency — it's proving the gate applies uniformly on every
    // delivery, not just the first.
    const second = await chariWebhookPost(signedRequest(refundPayload, "refund.succeeded", eventId));
    expect(second.status).toBe(202);
    const inventoryAfterSecond = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfterSecond.soldQuantity).toBe(inventoryBefore.soldQuantity);
  });
});
