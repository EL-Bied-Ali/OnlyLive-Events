import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";

const API_KEY = "chari_sk_test_unit-test-key";
const WEBHOOK_SECRET = "unit-test-charipay-webhook-secret";

function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function webhookHeaders(rawBody: string, type: string, eventId = "evt-1", secret = WEBHOOK_SECRET, timestamp = Date.now()) {
  const timestampRaw = String(timestamp);
  const signature = crypto.createHmac("sha256", secret).update(`${timestampRaw}.${rawBody}`).digest("hex");
  return {
    "x-chari-signature": signature,
    "x-chari-timestamp": timestampRaw,
    "chari-event-id": eventId,
    "chari-event-type": type,
  };
}

describe("ChariPayProvider", () => {
  beforeEach(() => {
    vi.stubEnv("CHARIPAY_API_KEY", API_KEY);
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET_NEXT", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("creates a hosted checkout session with MAD major units, stable externalId and idempotency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      sessionId: "ps_test_123",
      checkoutUrl: "https://pay.chari.ma/checkout/ps_test_123",
      expiresAt: "2026-09-15T00:00:00Z",
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ChariPayProvider();
    const result = await provider.createPayment({
      paymentId: "payment-123",
      orderId: "order-456",
      amountCents: 25_001,
      currency: "MAD",
      idempotencyKey: "idem-789",
      customerEmail: "buyer@example.com",
      returnUrl: "https://onlylive.ma/orders/order-456",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
    });

    expect(result).toEqual({
      providerPaymentId: "ps_test_123",
      redirectUrl: "https://pay.chari.ma/checkout/ps_test_123",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/payment-sessions");
    expect(init.headers).toMatchObject({
      "X-CHARI-PAY-API-KEY": API_KEY,
      "Idempotency-Key": "idem-789",
      "X-Request-Id": "payment-123",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      amount: 250.01,
      orderId: "order-456",
      externalId: "payment-123",
      config: {
        customer: { email: "buyer@example.com" },
        urls: {
          accept: "https://onlylive.ma/orders/order-456",
          decline: "https://onlylive.ma/orders/order-456",
          notification: "https://onlylive.ma/api/payments/webhook/charipay",
        },
      },
      metadata: { onlylivePaymentId: "payment-123", onlyliveOrderId: "order-456" },
    });
  });

  it("refuses non-MAD checkout rather than silently changing currency", async () => {
    const provider = new ChariPayProvider();
    await expect(provider.createPayment({
      paymentId: "payment",
      orderId: "order",
      amountCents: 1000,
      currency: "EUR",
      idempotencyKey: "idem",
      customerEmail: "buyer@example.com",
      returnUrl: "https://onlylive.ma/orders/order",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
    })).rejects.toThrow("only supports MAD");
  });

  it("verifies the documented timestamp.rawBody HMAC and extracts stable reconciliation references", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    const raw = JSON.stringify({
      externalId: "payment-123",
      amount: 250.01,
      currency: "MAD",
      sessionId: "ps_test_123",
      metadata: { onlylivePaymentId: "payment-123" },
    });
    const provider = new ChariPayProvider();
    const parsed = await provider.parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-123"),
    });

    expect(parsed).toMatchObject({
      externalEventId: "event-123",
      providerPaymentId: "ps_test_123",
      paymentExternalId: "payment-123",
      type: "payment.succeeded",
      amountCents: 25_001,
      currency: "MAD",
      signatureValid: true,
    });
  });

  it("rejects stale webhook timestamps even with a valid HMAC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    const raw = JSON.stringify({ externalId: "payment-123", amount: 10, currency: "MAD" });
    const stale = Date.now() - 5 * 60 * 1000 - 1;
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-stale", WEBHOOK_SECRET, stale),
    });
    expect(parsed.signatureValid).toBe(false);
  });

  it("accepts the next signing secret during webhook-secret rotation", async () => {
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET_NEXT", "next-secret");
    const raw = JSON.stringify({ externalId: "payment-123", amount: 10, currency: "MAD" });
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-next", "next-secret"),
    });
    expect(parsed.signatureValid).toBe(true);
  });

  it("submits refunds with the OnlyLive payment id and refund row id as ChariPay idempotency references", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      refundId: "rf_123",
      refundReference: "refund-row-123",
      status: "PENDING",
    }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ChariPayProvider().refund({
      providerPaymentId: "ps_test_123",
      paymentExternalId: "payment-123",
      amountCents: 12_345,
      reason: "Customer request",
      idempotencyKey: "refund-row-123",
    });
    expect(result).toEqual({ providerRefundId: "rf_123", state: "processing" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/refunds");
    expect(init.headers).toMatchObject({
      "X-CHARI-PAY-API-KEY": API_KEY,
      "Idempotency-Key": "refund-row-123",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      externalId: "payment-123",
      refundReference: "refund-row-123",
      refundAmount: 123.45,
      reason: "Customer request",
      metadata: { onlyliveRefundId: "refund-row-123" },
    });
  });
});
