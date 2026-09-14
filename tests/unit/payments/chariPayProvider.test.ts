import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/chariPayProvider";

const API_KEY = "chari_sk_test_onlylive_unit_test";
const WEBHOOK_SECRET = "onlylive-charipay-webhook-test-secret";

function signedHeaders(rawBody: string, type = "payment.succeeded", timestamp = Date.now()) {
  const timestampText = String(timestamp);
  const signature = crypto
    .createHmac("sha256", WEBHOOK_SECRET)
    .update(`${timestampText}.${rawBody}`)
    .digest("hex");
  return {
    "x-chari-signature": signature,
    "x-chari-timestamp": timestampText,
    "chari-event-id": "evt_charipay_1",
    "chari-event-type": type,
  };
}

beforeEach(() => {
  vi.stubEnv("CHARIPAY_API_KEY", API_KEY);
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ChariPayProvider", () => {
  it("creates a hosted checkout session with MAD major units, stable ids, HTTPS callbacks and our checkout expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          sessionId: "ps_5Kd0Rn",
          checkoutUrl: "https://pay.chari.ma/checkout/ps_5Kd0Rn",
          expiresAt: "2026-09-15T10:15:00Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const expiresAt = new Date("2026-09-15T10:15:00.000Z");
    const provider = new ChariPayProvider();
    const result = await provider.createPayment({
      paymentId: "payment-local-1",
      orderId: "order-local-1",
      orderNumber: "OL-2026-0001",
      amountCents: 24_990,
      currency: "MAD",
      idempotencyKey: "idem-payment-1",
      customerEmail: "buyer@example.com",
      returnUrl: "https://tickets.onlylive.ma/orders/order-local-1",
      declineUrl: "https://tickets.onlylive.ma/orders/order-local-1",
      notificationUrl: "https://tickets.onlylive.ma/api/payments/webhook/charipay",
      expiresAt,
    });

    expect(result).toEqual({
      providerPaymentId: "ps_5Kd0Rn",
      redirectUrl: "https://pay.chari.ma/checkout/ps_5Kd0Rn",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/payment-sessions");
    const headers = init.headers as Record<string, string>;
    expect(headers["x-chari-pay-api-key"]).toBe(API_KEY);
    expect(headers["idempotency-key"]).toBe("idem-payment-1");

    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({
      amount: 249.9,
      orderId: "OL-2026-0001",
      externalId: "payment-local-1",
      singleUse: true,
      notifyOnFailure: true,
      expiresAt: expiresAt.toISOString(),
      config: {
        customer: { email: "buyer@example.com" },
        urls: {
          accept: "https://tickets.onlylive.ma/orders/order-local-1",
          decline: "https://tickets.onlylive.ma/orders/order-local-1",
          notification: "https://tickets.onlylive.ma/api/payments/webhook/charipay",
        },
      },
      metadata: {
        onlyLivePaymentId: "payment-local-1",
        onlyLiveAmountCents: 24_990,
        onlyLiveCurrency: "MAD",
      },
    });
  });

  it("refuses non-MAD payments before making a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();

    await expect(
      provider.createPayment({
        paymentId: "pay-eur",
        orderId: "order-eur",
        amountCents: 1_000,
        currency: "EUR",
        idempotencyKey: "idem-eur",
        customerEmail: "buyer@example.com",
        returnUrl: "https://tickets.onlylive.ma/orders/order-eur",
      }),
    ).rejects.toThrow(/only supports MAD/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-HTTPS callback URLs before making a network call", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();

    await expect(
      provider.createPayment({
        paymentId: "pay-local-http",
        orderId: "order-local-http",
        amountCents: 1_000,
        currency: "MAD",
        idempotencyKey: "idem-http",
        customerEmail: "buyer@example.com",
        returnUrl: "http://localhost:3000/orders/order-local-http",
      }),
    ).rejects.toThrow(/must use HTTPS/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies ChariPay HMAC/timestamp on the raw body and reconciles through signed metadata", async () => {
    const rawBody = JSON.stringify({
      amount: 249.9,
      currency: "MAD",
      externalId: "payment-local-1",
      metadata: {
        onlyLivePaymentId: "payment-local-1",
        onlyLiveAmountCents: 24_990,
        onlyLiveCurrency: "MAD",
      },
    });
    const provider = new ChariPayProvider();
    const event = await provider.parseWebhook({ rawBody, headers: signedHeaders(rawBody) });

    expect(event).toMatchObject({
      externalEventId: "evt_charipay_1",
      paymentExternalId: "payment-local-1",
      type: "payment.succeeded",
      amountCents: 24_990,
      currency: "MAD",
      signatureValid: true,
    });
  });

  it("rejects a body changed after the signature was calculated", async () => {
    const original = JSON.stringify({
      metadata: {
        onlyLivePaymentId: "payment-local-1",
        onlyLiveAmountCents: 24_990,
        onlyLiveCurrency: "MAD",
      },
    });
    const tampered = JSON.stringify({
      metadata: {
        onlyLivePaymentId: "payment-local-1",
        onlyLiveAmountCents: 1,
        onlyLiveCurrency: "MAD",
      },
    });
    const provider = new ChariPayProvider();
    const event = await provider.parseWebhook({ rawBody: tampered, headers: signedHeaders(original) });
    expect(event.signatureValid).toBe(false);
  });

  it("rejects a correctly HMACed webhook whose timestamp is outside the five-minute replay window", async () => {
    const rawBody = JSON.stringify({
      externalId: "payment-local-old",
      metadata: {
        onlyLivePaymentId: "payment-local-old",
        onlyLiveAmountCents: 1_000,
        onlyLiveCurrency: "MAD",
      },
    });
    const provider = new ChariPayProvider();
    const event = await provider.parseWebhook({
      rawBody,
      headers: signedHeaders(rawBody, "payment.succeeded", Date.now() - 5 * 60 * 1000 - 1),
    });
    expect(event.signatureValid).toBe(false);
  });

  it("creates an idempotent asynchronous refund using the OnlyLive payment/refund ids", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "PENDING", refundReference: "refund-local-1" }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const provider = new ChariPayProvider();
    const result = await provider.refund({
      paymentExternalId: "payment-local-1",
      providerPaymentId: "ps_5Kd0Rn",
      amountCents: 5_025,
      currency: "MAD",
      reason: "Client cancellation",
      idempotencyKey: "refund-local-1",
    });

    expect(result).toEqual({ providerRefundId: "refund-local-1", status: "pending" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/refunds");
    expect(JSON.parse(String(init.body))).toMatchObject({
      externalId: "payment-local-1",
      refundReference: "refund-local-1",
      refundAmount: 50.25,
      reason: "Client cancellation",
      metadata: {
        onlyLiveRefundId: "refund-local-1",
        onlyLivePaymentId: "payment-local-1",
        onlyLiveAmountCents: 5_025,
        onlyLiveCurrency: "MAD",
      },
    });
  });

  it.each([
    ["PENDING", "pending"],
    ["SUCCESS", "succeeded"],
    ["FAILED", "failed"],
  ] as const)("maps refund status %s to %s", async (providerStatus, expected) => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: providerStatus, refundId: "crf_123", refundReference: "refund-local-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();

    await expect(provider.getRefundStatus("refund-local-1")).resolves.toEqual({
      providerRefundId: "crf_123",
      status: expected,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-psp.charipay.ma/v1/refunds/refund-local-1",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns not_found for a missing refund reference so the same idempotent request can be safely replayed", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { code: "OPERATION_NOT_FOUND", message: "not found" } }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();

    await expect(provider.getRefundStatus("refund-missing")).resolves.toEqual({
      providerRefundId: "refund-missing",
      status: "not_found",
    });
  });
});
