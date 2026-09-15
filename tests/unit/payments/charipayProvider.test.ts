import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { ProviderInputError, ProviderRequestError } from "@/lib/payments/provider";

const API_KEY = "chari_sk_test_unit-key";
const WEBHOOK_SECRET = "unit-webhook-secret";

function response(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function signedHeaders(rawBody: string, secret = WEBHOOK_SECRET, timestamp = Date.now()) {
  const timestampRaw = String(timestamp);
  const signature = crypto.createHmac("sha256", secret).update(`${timestampRaw}.${rawBody}`).digest("hex");
  return {
    "x-chari-signature": signature,
    "x-chari-timestamp": timestampRaw,
    "chari-event-id": "evt-unit",
    "chari-event-type": "payment.succeeded",
  };
}

describe("ChariPayProvider", () => {
  beforeEach(() => {
    vi.stubEnv("CHARIPAY_API_KEY", API_KEY);
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET_NEXT", "");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("creates a hosted checkout session with MAD major units, stable ids, HTTPS callbacks and OnlyLive expiry", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      sessionId: "ps_unit_123",
      checkoutUrl: "https://pay.charipay.ma/session/unit",
    }, 201));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();
    const expiresAt = new Date("2030-01-01T00:10:00.000Z");

    const result = await provider.createPayment({
      paymentId: "payment-unit",
      orderId: "order-unit",
      amountCents: 12_345,
      currency: "MAD",
      idempotencyKey: "payment-unit",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-unit",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
      expiresAt,
    });

    expect(result).toEqual({
      providerPaymentId: "ps_unit_123",
      redirectUrl: "https://pay.charipay.ma/session/unit",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/payment-sessions");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      "X-CHARI-PAY-API-KEY": API_KEY,
      "Idempotency-Key": "payment-unit",
      "X-Request-Id": "payment-unit",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      amount: 123.45,
      orderId: "order-unit",
      externalId: "payment-unit",
      expiresAt: expiresAt.toISOString(),
      config: {
        customer: {
          firstName: "Amine",
          lastName: "Bennani",
          email: "buyer@example.com",
          phone: "+212600000000",
        },
        urls: {
          accept: "https://onlylive.ma/orders/order-unit",
          decline: "https://onlylive.ma/orders/order-unit",
          notification: "https://onlylive.ma/api/payments/webhook/charipay",
        },
      },
      metadata: { onlylivePaymentId: "payment-unit", onlyliveOrderId: "order-unit" },
    });
  });

  it("keeps ChariPay customer validation inside the adapter", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();
    const base = {
      paymentId: "payment-unit",
      orderId: "order-unit",
      amountCents: 1_000,
      currency: "MAD",
      idempotencyKey: "payment-unit",
      customerEmail: "buyer@example.com",
      returnUrl: "https://onlylive.ma/orders/order-unit",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
      expiresAt: new Date(Date.now() + 60_000),
    };

    await expect(provider.createPayment({ ...base, customerName: null, customerPhone: "+212600000000" }))
      .rejects.toBeInstanceOf(ProviderInputError);
    await expect(provider.createPayment({ ...base, customerName: "Amine Bennani", customerPhone: null }))
      .rejects.toBeInstanceOf(ProviderInputError);
    await expect(provider.createPayment({ ...base, customerName: "Amine Bennani", customerPhone: "not-a-phone" }))
      .rejects.toBeInstanceOf(ProviderInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-MAD checkout and unsafe callbacks before network I/O", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();
    const base = {
      paymentId: "payment-unit",
      orderId: "order-unit",
      amountCents: 1_000,
      idempotencyKey: "payment-unit",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-unit",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
      expiresAt: new Date(Date.now() + 60_000),
    };
    await expect(provider.createPayment({ ...base, currency: "EUR" })).rejects.toThrow("only supports MAD");
    await expect(provider.createPayment({ ...base, currency: "MAD", returnUrl: "http://onlylive.ma/order" })).rejects.toThrow("HTTPS");
    await expect(provider.createPayment({ ...base, currency: "MAD", webhookUrl: "https://onlylive.ma:8443/hook" })).rejects.toThrow("HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a missing or expired checkout deadline", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();
    const base = {
      paymentId: "payment-unit",
      orderId: "order-unit",
      amountCents: 1_000,
      currency: "MAD",
      idempotencyKey: "payment-unit",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-unit",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
    };
    await expect(provider.createPayment(base)).rejects.toThrow("future checkout expiry");
    await expect(provider.createPayment({ ...base, expiresAt: new Date(Date.now() - 1) })).rejects.toThrow("future checkout expiry");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an unsafe hosted checkout URL returned by the provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      sessionId: "ps_unit",
      checkoutUrl: "javascript:alert(1)",
    }, 201)));
    await expect(new ChariPayProvider().createPayment({
      paymentId: "payment-unit",
      orderId: "order-unit",
      amountCents: 1_000,
      currency: "MAD",
      idempotencyKey: "payment-unit",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-unit",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toBeInstanceOf(ProviderRequestError);
  });

  it("verifies timestamp.rawBody HMAC and extracts provisional immutable webhook facts", async () => {
    const raw = JSON.stringify({
      externalId: "payment-unit",
      sessionId: "ps_unit",
      amount: 123.45,
      currency: "MAD",
      metadata: { onlylivePaymentId: "payment-unit" },
    });
    const parsed = await new ChariPayProvider().parseWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(parsed).toMatchObject({
      externalEventId: "evt-unit",
      providerPaymentId: "ps_unit",
      paymentExternalId: "payment-unit",
      type: "payment.succeeded",
      amountCents: 12_345,
      currency: "MAD",
      signatureValid: true,
      payloadValid: true,
    });
  });

  it("fails closed when a signed payload lacks required reconciliation facts", async () => {
    const raw = JSON.stringify({ externalId: "payment-unit" });
    const parsed = await new ChariPayProvider().parseWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.payloadValid).toBe(false);
  });

  it("fails closed when a signed financial payload omits currency", async () => {
    const raw = JSON.stringify({ externalId: "payment-unit", amount: 10 });
    const parsed = await new ChariPayProvider().parseWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.payloadValid).toBe(false);
  });

  it("rejects stale webhook timestamps even with a valid HMAC", async () => {
    const raw = JSON.stringify({ externalId: "payment-unit", amount: 10, currency: "MAD" });
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: signedHeaders(raw, WEBHOOK_SECRET, Date.now() - 10 * 60 * 1000),
    });
    expect(parsed.signatureValid).toBe(false);
  });

  it("accepts the next signing secret during webhook-secret rotation", async () => {
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET_NEXT", "next-secret");
    const raw = JSON.stringify({ externalId: "payment-unit", amount: 10, currency: "MAD" });
    const timestamp = Date.now();
    const timestampRaw = String(timestamp);
    const nextSignature = crypto.createHmac("sha256", "next-secret").update(`${timestampRaw}.${raw}`).digest("hex");
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: {
        "x-chari-signature": "0".repeat(64),
        "x-chari-signature-next": nextSignature,
        "x-chari-timestamp": timestampRaw,
        "chari-event-id": "evt-rotation",
        "chari-event-type": "payment.succeeded",
      },
    });
    expect(parsed.signatureValid).toBe(true);
  });

  it("submits refunds with a stable refundReference and MAD amount", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ refundId: "rf_123", status: "PENDING" }, 202));
    vi.stubGlobal("fetch", fetchMock);
    const result = await new ChariPayProvider().refund({
      providerPaymentId: "ps_123",
      paymentExternalId: "payment-123",
      amountCents: 1_250,
      currency: "MAD",
      reason: "Customer request",
      idempotencyKey: "refund-row-123",
    });
    expect(result).toEqual({ providerRefundId: "rf_123", state: "processing" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/refunds");
    expect(init.headers).toMatchObject({ "Idempotency-Key": "refund-row-123", "X-Request-Id": "refund-row-123" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      externalId: "payment-123",
      refundReference: "refund-row-123",
      refundAmount: 12.5,
      reason: "Customer request",
      metadata: { onlyliveRefundId: "refund-row-123" },
    });
  });

  it("retrieves refund state by stable reference and maps 404 to not_found", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ refundId: "rf_123", refundReference: "refund-row-123", status: "SUCCESS" }))
      .mockResolvedValueOnce(response({ error: { code: "NOT_FOUND" } }, 404));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();
    await expect(provider.getRefundStatus("refund-row-123")).resolves.toEqual({
      providerRefundId: "rf_123",
      status: "succeeded",
    });
    await expect(provider.getRefundStatus("missing")).resolves.toEqual({ providerRefundId: null, status: "not_found" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api-psp.charipay.ma/v1/refunds/refund-row-123");
  });

  it("treats 408, 429 and 5xx refund responses as ambiguous/retryable", async () => {
    for (const status of [408, 429, 503]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "RETRY_LATER" } }, status)));
      await expect(new ChariPayProvider().refund({
        providerPaymentId: "ps",
        paymentExternalId: "payment",
        amountCents: 1000,
        currency: "MAD",
        reason: "test",
        idempotencyKey: `refund-${status}`,
      })).rejects.toMatchObject({ outcomeUnknown: true, status });
    }
  });

  it("keeps refund HTTP 409 outcomes ambiguous and preserves safe retry diagnostics", async () => {
    const provider = new ChariPayProvider();
    const input = { providerPaymentId: "ps", paymentExternalId: "payment", amountCents: 1000, currency: "MAD", reason: "test", idempotencyKey: "refund-409" };
    // The global ChariPay error catalogue also uses session-specific 409 codes,
    // but the refund endpoint does not document them as proof that no refund
    // was created. On a money-moving POST, any 409 therefore remains reserved
    // until lookup/reconciliation proves a terminal refund state.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "SESSION_NOT_ACTIVE" } }, 409)));
    await expect(provider.refund(input)).rejects.toMatchObject({ outcomeUnknown: true, status: 409 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "IDEMPOTENCY_CONFLICT" } }, 409)));
    await expect(provider.refund(input)).rejects.toMatchObject({ outcomeUnknown: true, status: 409 });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { code: "RATE_LIMITED" }, correlationId: "corr-safe-123" }), { status: 429, headers: { "content-type": "application/json", "retry-after": "2" } })));
    await expect(provider.refund(input)).rejects.toMatchObject({ outcomeUnknown: true, status: 429, retryAfterMs: 2000, correlationId: "corr-safe-123" });
  });

  it("treats a provider 4xx validation rejection as definitive", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({ error: { code: "BAD_REQUEST" } }, 400)));
    try {
      await new ChariPayProvider().refund({
        providerPaymentId: "ps",
        paymentExternalId: "payment",
        amountCents: 1000,
        currency: "MAD",
        reason: "test",
        idempotencyKey: "refund-400",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({ outcomeUnknown: false, status: 400 });
    }
  });
});
