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
  vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-automation-bypass-secret");
  // Payment event headers are not covered by ChariPay's HMAC. The route now
  // independently confirms header-claimed payment outcomes through the
  // authenticated transaction ledger. Individual tests override this spy when
  // exercising contradictions/unavailable lookup states.
  return vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
    status: "succeeded",
    providerOperationId: "123456",
    providerStatus: "SUCCESS",
  });
}

function signedRequest(
  payload: unknown,
  type: string,
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

  it("requires authenticated provider-ledger confirmation before honoring payment.succeeded", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    const lookupSpy = enableChariPay();
    lookupSpy.mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-confirmed",
      providerStatus: "SUCCESS",
    });

    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
    ));

    expect(response.status).toBe(200);
    expect(lookupSpy).toHaveBeenCalledWith({
      orderExternalId: fixture.order.id,
      amountCents: fixture.payment.amountCents,
      currency: "MAD",
    });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(1);
  });

  it("never fulfills a header-claimed payment.succeeded when the authenticated ledger says failed", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    const lookupSpy = enableChariPay();
    lookupSpy.mockResolvedValue({
      status: "failed",
      providerOperationId: "op-failed",
      providerStatus: "FAILED",
    });
    const eventId = crypto.randomUUID();

    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
      eventId,
    ));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({
      status: "awaiting_payment",
    });
    expect(await prisma.paymentEvent.count({
      where: { provider: "charipay", externalEventId: eventId },
    })).toBe(0);
    expect(await prisma.auditLog.count({
      where: {
        action: "payment.webhook_header_status_mismatch",
        entityType: "Payment",
        entityId: fixture.payment.id,
      },
    })).toBeGreaterThanOrEqual(1);
  });

  it("returns 503 without mutation when provider-ledger confirmation is temporarily unavailable", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    const lookupSpy = enableChariPay();
    lookupSpy.mockRejectedValue(new Error("simulated lookup outage"));
    const eventId = crypto.randomUUID();

    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
      eventId,
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "PROVIDER_STATUS_VERIFICATION_UNAVAILABLE" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    expect(await prisma.paymentEvent.count({
      where: { provider: "charipay", externalEventId: eventId },
    })).toBe(0);
  });

  it("returns 503 without mutation when the authenticated ledger is not yet conclusive", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    const lookupSpy = enableChariPay();
    lookupSpy.mockResolvedValue({
      status: "pending",
      providerOperationId: "op-pending",
      providerStatus: "PENDING",
    });

    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
    ));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "PROVIDER_STATUS_NOT_CONFIRMED" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
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
    const sensitiveEcho = "sensitive-buyer@example.com";
    const payload = {
      ...paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      ProviderEchoedCustomer: sensitiveEcho,
    };

    const first = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({ ok: true, outcome: "paid" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(2);

    const storedEvent = await prisma.paymentEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: "charipay", externalEventId: eventId } },
    });
    expect(storedEvent.rawPayload).toMatchObject({
      version: "charipay_webhook_fingerprint_v1",
      fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      topLevelFieldCount: Object.keys(payload).length,
    });
    const storedJson = JSON.stringify(storedEvent.rawPayload);
    expect(storedJson).not.toContain(sensitiveEcho);
    expect(storedJson).not.toContain(fixture.payment.id);
    expect(storedJson).not.toContain(fixture.order.id);

    const duplicate = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(duplicate.status).toBe(200);
    await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    // Backward compatibility with pre-hardening rows that stored the complete
    // provider JSON: a historical unprocessed/processed event must still be
    // recognized by fingerprinting the legacy value on read.
    await prisma.paymentEvent.update({
      where: { id: storedEvent.id },
      data: { rawPayload: payload },
    });
    const legacyDuplicate = await chariWebhookPost(signedRequest(payload, "payment.succeeded", eventId));
    expect(legacyDuplicate.status).toBe(200);
    await expect(legacyDuplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true });

    const collision = await chariWebhookPost(signedRequest(
      { ...payload, metadata: { onlylivePaymentId: fixture.payment.id, onlyliveOrderId: fixture.order.id, changed: true } },
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
    expect(await prisma.emailOutbox.count({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    })).toBe(0);
  });

  it("enqueues an order_confirmation row atomically with the payment.succeeded transaction, since the merge with the durable email outbox", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
    ));
    expect(response.status).toBe(200);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    const rows = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.recipientEmail).toBe(fixture.user.email);
  });

  it("acknowledges a signed payment.failed with 202 and never mutates state, since its shape is unverified", async () => {
    // payment.failed shares payment.succeeded's guessed Amount/metadata
    // envelope by extrapolation only (charipayProvider.ts's parseWebhook) —
    // CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED gates it closed before
    // any lookup/mutation runs, exactly like the refund gate below. This
    // used to assert the old (unsafe) processed behavior; it now proves
    // the opposite on purpose.
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.failed",
    ));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "awaiting_payment" });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
    expect(await prisma.emailOutbox.count({
      where: { type: "payment_failed", entityType: "order", entityId: fixture.order.id },
    })).toBe(0);
  });

  it("reaches the payment.failed unverified-shape gate even with a malformed/unexpected body, instead of being rejected by guessed payload validation", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      { thisFieldDoesNotExistOnAnyRealChariPayPayload: true },
      "payment.failed",
    ));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "awaiting_payment" });
  });

  it("records the payment.failed unverified-shape evidence exactly once for concurrent duplicate deliveries", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const eventId = crypto.randomUUID();
    const sensitiveProviderValue = "failed-buyer@example.com";
    const payload = {
      ...paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      UnexpectedCustomerEcho: sensitiveProviderValue,
    };

    const [first, duplicate] = await Promise.all([
      chariWebhookPost(signedRequest(payload, "payment.failed", eventId)),
      chariWebhookPost(signedRequest(payload, "payment.failed", eventId)),
    ]);
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);

    expect(await prisma.auditLog.count({
      where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: eventId },
    })).toBe(1);
    const evidence = await prisma.auditLog.findFirstOrThrow({
      where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: eventId },
    });
    expect(evidence.metadata).toMatchObject({
      provider: "charipay",
      eventType: "payment.failed",
      payloadEvidence: {
        version: "charipay_webhook_fingerprint_v1",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
      },
    });
    expect(JSON.stringify(evidence.metadata)).not.toContain(sensitiveProviderValue);
    expect(JSON.stringify(evidence.metadata)).not.toContain(fixture.payment.id);
  });

  it("does not misclassify an unknown signed provider event type as payment.failed", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const eventId = crypto.randomUUID();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.unknown_future_event",
      eventId,
    ));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_PROVIDER_PAYLOAD" });
    expect(await prisma.auditLog.count({
      where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: eventId },
    })).toBe(0);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({
      status: "awaiting_payment",
    });
  });

  it("still rejects an invalid signature before the payment.failed unverified-shape gate", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const eventId = crypto.randomUUID();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.failed",
      eventId,
      "0".repeat(64),
    ));
    expect(response.status).toBe(401);
    // Scoped by this test's own eventId: this shared, persistent test
    // database accumulates rows from other tests' own payment.failed events.
    expect(await prisma.auditLog.count({
      where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: eventId },
    })).toBe(0);
  });

  it("never applies the payment.failed unverified-shape gate to payment.succeeded or refund.* events", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const succeededEventId = crypto.randomUUID();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
      succeededEventId,
    ));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, outcome: "paid" });
    expect(await prisma.auditLog.count({
      where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: succeededEventId },
    })).toBe(0);

    const admin = await createAdmin();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_gate_scope", state: "processing" });
    const initiated = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Gate scope test",
      actorId: admin.id,
    });
    const refundEventId = crypto.randomUUID();
    const refundResponse = await chariWebhookPost(signedRequest({
      RefundId: "rf_gate_scope",
      RefundAmount: fixture.payment.amountCents / 100,
      metadata: { onlyliveRefundId: initiated.refundId, onlylivePaymentId: fixture.payment.id },
    }, "refund.failed", refundEventId));
    expect(refundResponse.status).toBe(202);
    expect(await prisma.auditLog.count({
      where: { action: "charipay.payment_failed_shape_unverified", entityType: "PaymentProviderEvent", entityId: refundEventId },
    })).toBe(0);
  });

  it("enqueues a reconciliation alert atomically when payment.succeeded resolves to paid_but_unfulfillable", async () => {
    // Added during the PR #13 rebase onto PR #16 (admin reconciliation
    // alerts): the fake webhook route already enqueued this; the ChariPay
    // route did not, since PR #16 didn't exist yet when it was written —
    // ChariPay-originated stuck orders would otherwise silently never
    // alert anyone while fake-provider ones did.
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 10_000 });
    await prisma.reservation.update({ where: { id: fixture.reservationId }, data: { status: "expired" } });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
      "payment.succeeded",
    ));
    expect(response.status).toBe(200);
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "paid_but_unfulfillable" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });

    const rows = await prisma.emailOutbox.findMany({
      where: { type: "reconciliation_alert", entityType: "order", entityId: { startsWith: `${fixture.order.id}:` } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.status).toBe("pending");
    // No order_confirmation should have been enqueued for an unfulfillable order.
    expect(await prisma.emailOutbox.count({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    })).toBe(0);
  });

  it("fails closed on a payment webhook missing metadata.onlyliveOrderId, even with a correct payment id", async () => {
    // metadata.onlyliveOrderId is a required second reconciliation
    // invariant, not an optional bonus check — a real payment.succeeded
    // delivery always carries both (createPayment() always sends both in
    // the same metadata object), so a payload missing it is malformed
    // regardless of how correct paymentExternalId looks.
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest({
      Amount: fixture.payment.amountCents / 100,
      metadata: { onlylivePaymentId: fixture.payment.id },
    }, "payment.succeeded"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "INVALID_PROVIDER_PAYLOAD" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("rejects a payment webhook whose metadata.onlyliveOrderId does not match the payment's actual order", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const response = await chariWebhookPost(signedRequest({
      Amount: fixture.payment.amountCents / 100,
      metadata: { onlylivePaymentId: fixture.payment.id, onlyliveOrderId: crypto.randomUUID() },
    }, "payment.succeeded"));
    expect(response.status).toBe(409);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "awaiting_payment" });
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

  it("acknowledges a signed refund event with a completely unfamiliar body shape, not 400", async () => {
    // The shape-verified gate must fire on event type + event id alone,
    // BEFORE the generic payloadValid check that depends on the guessed
    // refund field names (RefundAmount/refundAmount, onlyliveRefundId/
    // RefundReference/refundReference). A real refund delivery whose actual
    // field names differ entirely from that guess must still be 202'd for
    // reconciliation, not rejected as 400 INVALID_PROVIDER_PAYLOAD — that
    // would defeat the whole point of failing closed instead of guessing.
    enableChariPay();
    const eventId = crypto.randomUUID();
    const sensitiveProviderValue = "refund-buyer@example.com";
    const response = await chariWebhookPost(signedRequest({
      totallyUnfamiliarField: sensitiveProviderValue,
      nested: { alsoUnfamiliar: 12345 },
    }, "refund.succeeded", eventId));

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({ ok: true, reconciliationRequired: true });
    // This shared, persistent test database accumulates Refund rows from
    // other tests, so assert no financial mutation by event scope (this
    // event carries no refundExternalId at all, so nothing it could have
    // touched exists) rather than by a global count.
    expect(await prisma.auditLog.count({
      where: { action: "refund.webhook_shape_unverified", metadata: { path: ["externalEventId"], equals: eventId } },
    })).toBe(1);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "refund.webhook_shape_unverified", metadata: { path: ["externalEventId"], equals: eventId } },
    });
    expect(audit.metadata).toMatchObject({
      eventType: "refund.succeeded",
      payloadEvidence: {
        version: "charipay_webhook_fingerprint_v1",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        topLevelFieldCount: 2,
      },
    });
    expect(JSON.stringify(audit.metadata)).not.toContain(sensitiveProviderValue);
    expect(JSON.stringify(audit.metadata)).not.toContain("12345");
  });

  it("does not retain provider-controlled JSON property names in unverified-shape evidence", async () => {
    enableChariPay();
    const sensitivePropertyName = "buyer@example.com";
    const eventId = crypto.randomUUID();
    const response = await chariWebhookPost(signedRequest({
      [sensitivePropertyName]: "otherwise harmless value",
    }, "refund.succeeded", eventId));

    expect(response.status).toBe(202);
    const audit = await prisma.auditLog.findFirstOrThrow({
      where: { action: "refund.webhook_shape_unverified", metadata: { path: ["externalEventId"], equals: eventId } },
    });
    const serialized = JSON.stringify(audit.metadata);
    expect(serialized).not.toContain(sensitivePropertyName);
    expect(audit.metadata).toMatchObject({
      payloadEvidence: {
        version: "charipay_webhook_fingerprint_v1",
        fingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
        topLevelFieldCount: 1,
      },
    });
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
