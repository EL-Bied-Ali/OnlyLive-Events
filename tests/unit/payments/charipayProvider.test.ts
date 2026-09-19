import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { ProviderInputError, ProviderRequestError } from "@/lib/payments/provider";

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

  it("creates a hosted checkout session with MAD major units, stable ids, HTTPS callbacks and OnlyLive expiry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    const checkoutExpiry = new Date("2026-09-14T18:10:00Z");
    const fetchMock = vi.fn().mockResolvedValue(response({
      sessionId: "ps_test_123",
      checkoutUrl: "https://pay.chari.ma/checkout/ps_test_123",
      expiresAt: checkoutExpiry.toISOString(),
    }, 201));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ChariPayProvider().createPayment({
      paymentId: "payment-123",
      orderId: "order-456",
      amountCents: 25_001,
      currency: "MAD",
      idempotencyKey: "idem-789",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-456",
      expiresAt: checkoutExpiry,
    });

    expect(result).toEqual({ providerPaymentId: "ps_test_123", redirectUrl: "https://pay.chari.ma/checkout/ps_test_123" });
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
      singleUse: true,
      externalId: "payment-123",
      expiresAt: checkoutExpiry.toISOString(),
      notifyOnFailure: true,
      config: {
        customer: { firstName: "Amine", lastName: "Bennani", email: "buyer@example.com", phone: "+212600000000" },
        urls: {
          accept: "https://onlylive.ma/orders/order-456",
          decline: "https://onlylive.ma/orders/order-456",
        },
      },
      metadata: { onlylivePaymentId: "payment-123", onlyliveOrderId: "order-456" },
    });
  });

  it("never exposes provider-controlled API error prose through ProviderRequestError.message", async () => {
    const sensitiveMessage = "rejected buyer@example.com token=secret-value";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "BAD_REQUEST", message: sensitiveMessage },
      correlationId: "corr-safe-error-message",
    }, 400)));

    await expect(new ChariPayProvider().createPayment({
      paymentId: "payment-safe-error",
      orderId: "order-safe-error",
      amountCents: 1_000,
      currency: "MAD",
      idempotencyKey: "idem-safe-error",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-safe-error",
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      message: "ChariPay request failed (BAD_REQUEST)",
      providerCode: "BAD_REQUEST",
      correlationId: "corr-safe-error-message",
      outcomeUnknown: false,
    });

    try {
      await new ChariPayProvider().createPayment({
        paymentId: "payment-safe-error-2",
        orderId: "order-safe-error-2",
        amountCents: 1_000,
        currency: "MAD",
        idempotencyKey: "idem-safe-error-2",
        customerEmail: "buyer@example.com",
        customerName: "Amine Bennani",
        customerPhone: "+212600000000",
        returnUrl: "https://onlylive.ma/orders/order-safe-error-2",
        expiresAt: new Date(Date.now() + 60_000),
      });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("buyer@example.com");
      expect(String((error as Error).message)).not.toContain("secret-value");
    }
  });

  it("never exposes provider-controlled cancellation prose through ProviderRequestError.message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      error: { code: "CANCEL_REJECTED", message: "customer=buyer@example.com internal=secret-value" },
    }, 400)));

    await expect(new ChariPayProvider().closePaymentSession("ps-safe-error", "request-safe-error")).rejects.toMatchObject({
      name: "ProviderRequestError",
      message: "ChariPay session cancellation failed (CANCEL_REJECTED)",
      providerCode: "CANCEL_REJECTED",
      outcomeUnknown: false,
    });
  });

  it("keeps ChariPay customer validation inside the adapter", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const base = {
      paymentId: "payment-customer", orderId: "order-customer", amountCents: 1000, currency: "MAD",
      idempotencyKey: "idem-customer", customerEmail: "buyer@example.com", customerName: "Amine Bennani",
      returnUrl: "https://onlylive.ma/orders/order-customer",
      expiresAt: new Date(Date.now() + 60_000),
    };
    const provider = new ChariPayProvider();
    await expect(provider.createPayment(base)).rejects.toBeInstanceOf(ProviderInputError);
    await expect(provider.createPayment({ ...base, customerPhone: "bad-phone" })).rejects.toMatchObject({
      code: "PAYMENT_CUSTOMER_DETAILS_REQUIRED",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses non-MAD checkout and unsafe callbacks before network I/O", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ChariPayProvider();
    const base = {
      paymentId: "payment",
      orderId: "order",
      amountCents: 1000,
      idempotencyKey: "idem",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order",
      expiresAt: new Date(Date.now() + 60_000),
    };
    await expect(provider.createPayment({ ...base, currency: "EUR" })).rejects.toThrow("only supports MAD");
    await expect(provider.createPayment({
      ...base,
      currency: "MAD",
      returnUrl: "http://localhost:3000/orders/order",
    })).rejects.toThrow("must use HTTPS");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses a missing or expired checkout deadline", async () => {
    const provider = new ChariPayProvider();
    const base = {
      paymentId: "payment",
      orderId: "order",
      amountCents: 1000,
      currency: "MAD",
      idempotencyKey: "idem",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order",
    };
    await expect(provider.createPayment(base)).rejects.toThrow("future checkout expiry");
    await expect(provider.createPayment({ ...base, expiresAt: new Date(Date.now() - 1) })).rejects.toThrow("future checkout expiry");
  });

  it("rejects an unsafe hosted checkout URL returned by the provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      sessionId: "ps_test_123",
      checkoutUrl: "javascript:alert(1)",
    }, 201)));
    await expect(new ChariPayProvider().createPayment({
      paymentId: "payment",
      orderId: "order",
      amountCents: 1000,
      currency: "MAD",
      idempotencyKey: "idem",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order",
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toThrow(/checkoutUrl/);
  });

  it("verifies timestamp.rawBody HMAC and extracts provisional immutable webhook facts", async () => {
    // Matches a real signed sandbox delivery for payment.succeeded
    // (captured 2026-09-17 via ChariPay's partner webhook-events API):
    // ChariPay's own generated fields (Amount, ExternalId, Reference, ...)
    // are PascalCased and ExternalId/Reference carry the ORDER id, not the
    // Payment id — only metadata.onlylivePaymentId (echoed back verbatim
    // from our own request) resolves the Payment row. There is no
    // sessionId-equivalent field on a real delivery.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    const raw = JSON.stringify({
      Amount: 250.01,
      ExternalId: "order-456",
      Reference: "order-456",
      metadata: { onlylivePaymentId: "payment-123", onlyliveOrderId: "order-456" },
    });
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-123"),
    });

    expect(parsed).toMatchObject({
      externalEventId: "event-123",
      providerPaymentId: "",
      paymentExternalId: "payment-123",
      type: "payment.succeeded",
      amountCents: 25_001,
      currency: "MAD",
      signatureValid: true,
      payloadValid: true,
    });
  });

  it("fails closed when a signed payload lacks required reconciliation facts", async () => {
    const raw = JSON.stringify({ ExternalId: "order-123" });
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-incomplete"),
    });
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.payloadValid).toBe(false);
    expect(parsed.amountCents).toBe(0);
  });

  it("fails closed when a signed payment payload has Amount but no metadata.onlylivePaymentId", async () => {
    // ExternalId/Reference alone must never be treated as the payment id —
    // on a real ChariPay delivery they carry the ORDER id, not the
    // Payment id (see charipayProvider.ts's parseWebhook comments and the
    // "verifies ... webhook facts" test above). ChariPay's webhook also
    // carries no currency field at all, so there is nothing to "omit" —
    // currency is always asserted as "MAD", never parsed.
    const raw = JSON.stringify({ Amount: 10, ExternalId: "order-123", Reference: "order-123" });
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-no-metadata"),
    });
    expect(parsed.signatureValid).toBe(true);
    expect(parsed.currency).toBe("MAD");
    expect(parsed.paymentExternalId).toBeUndefined();
    expect(parsed.payloadValid).toBe(false);
  });

  it("rejects stale webhook timestamps even with a valid HMAC", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    const raw = JSON.stringify({ Amount: 10, metadata: { onlylivePaymentId: "payment-123" } });
    const stale = Date.now() - 5 * 60 * 1000 - 1;
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-stale", WEBHOOK_SECRET, stale),
    });
    expect(parsed.signatureValid).toBe(false);
  });

  it("accepts the next signing secret during webhook-secret rotation", async () => {
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET_NEXT", "next-secret");
    const raw = JSON.stringify({ Amount: 10, metadata: { onlylivePaymentId: "payment-123" } });
    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody: raw,
      headers: webhookHeaders(raw, "payment.succeeded", "event-next", "next-secret"),
    });
    expect(parsed.signatureValid).toBe(true);
  });

  it("submits refunds with a stable refundReference and MAD amount", async () => {
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
      currency: "MAD",
      reason: "Customer request",
      idempotencyKey: "refund-row-123",
    });
    expect(result).toEqual({ providerRefundId: "rf_123", state: "processing" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api-psp.charipay.ma/v1/refunds");
    expect(JSON.parse(String(init.body))).toMatchObject({
      externalId: "payment-123",
      refundReference: "refund-row-123",
      refundAmount: 123.45,
    });
  });

  it("resolves a verified SUCCESS ledger operation before submitting a refund", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        data: [{
          operationId: 281,
          type: "PAYMENT",
          status: "SUCCESS",
          amount: 10,
          currency: "MAD",
          direction: "IN",
          externalReference: "order-123",
        }],
        hasMore: false,
        nextCursor: null,
      }))
      .mockResolvedValueOnce(response({
        refundId: "rf_operation",
        refundReference: "refund-operation",
        status: "PENDING",
      }, 202));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ChariPayProvider().refund({
      providerPaymentId: "ps_test_123",
      paymentExternalId: "payment-123",
      orderExternalId: "order-123",
      paymentAmountCents: 1_000,
      amountCents: 500,
      currency: "MAD",
      reason: "Partial refund",
      idempotencyKey: "refund-operation",
    });

    expect(result).toEqual({ providerRefundId: "rf_operation", state: "processing" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://api-psp.charipay.ma/v1/transactions?type=PAYMENT&search=order-123&limit=50",
    );
    expect(fetchMock.mock.calls[1]?.[0]).toBe("https://api-psp.charipay.ma/v1/refunds");
    const refundBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(refundBody).toMatchObject({
      operationId: 281,
      refundReference: "refund-operation",
      refundAmount: 5,
      reason: "Partial refund",
    });
    expect(refundBody).not.toHaveProperty("externalId");
  });

  it("never submits a refund when the original ledger payment is not definitively verified", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({
      data: [{
        operationId: 300,
        type: "PAYMENT",
        status: "PENDING_3DS",
        amount: 10,
        currency: "MAD",
        direction: "IN",
        externalReference: "order-pending",
      }],
      hasMore: false,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ChariPayProvider().refund({
      providerPaymentId: "ps_pending",
      paymentExternalId: "payment-pending",
      orderExternalId: "order-pending",
      paymentAmountCents: 1_000,
      amountCents: 500,
      currency: "MAD",
      reason: "Must fail closed",
      idempotencyKey: "refund-pending",
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      outcomeUnknown: false,
      providerCode: "ORIGINAL_PAYMENT_NOT_VERIFIED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("classifies a pre-submit ledger lookup failure as no refund submitted", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        error: { code: "RATE_LIMITED", message: "slow down" },
        correlationId: "corr-ledger-rate",
      }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": "3" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ChariPayProvider().refund({
      providerPaymentId: "ps_rate",
      paymentExternalId: "payment-rate",
      orderExternalId: "order-rate",
      paymentAmountCents: 1_000,
      amountCents: 500,
      currency: "MAD",
      reason: "Lookup rate limited",
      idempotencyKey: "refund-rate-lookup",
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      outcomeUnknown: false,
      status: 429,
      retryAfterMs: 3_000,
      correlationId: "corr-ledger-rate",
      providerCode: "RATE_LIMITED",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it("treats 429 and 5xx refund responses as ambiguous/retryable", async () => {
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

  it("keeps refund 409 outcomes ambiguous and preserves safe retry diagnostics", async () => {
    const provider = new ChariPayProvider();
    const input = { providerPaymentId: "ps", paymentExternalId: "payment", amountCents: 1000, currency: "MAD", reason: "test", idempotencyKey: "refund-409" };
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
      expect(error).toMatchObject({ outcomeUnknown: false, status: 400, providerCode: "BAD_REQUEST" });
    }
  });

  it("extracts only a sanitized missing-field hint from a MISSING_PARAMETER message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({
        error: { code: "MISSING_PARAMETER", message: "Missing required parameter: walletId" },
        correlationId: "corr-missing-wallet",
      }, 400)),
    );
    try {
      await new ChariPayProvider().refund({
        providerPaymentId: "ps",
        paymentExternalId: "payment",
        amountCents: 1000,
        currency: "MAD",
        reason: "test",
        idempotencyKey: "refund-missing-field",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({
        outcomeUnknown: false,
        status: 400,
        providerCode: "MISSING_PARAMETER",
        providerFieldHint: "walletId",
        correlationId: "corr-missing-wallet",
      });
    }
  });

  it("does not turn provider values into a field hint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({
        error: { code: "MISSING_PARAMETER", message: "Missing required parameter: buyer@example.com" },
        correlationId: "corr-missing-sensitive-looking-value",
      }, 400)),
    );
    try {
      await new ChariPayProvider().refund({
        providerPaymentId: "ps",
        paymentExternalId: "payment",
        amountCents: 1000,
        currency: "MAD",
        reason: "test",
        idempotencyKey: "refund-missing-no-hint",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({
        providerCode: "MISSING_PARAMETER",
        providerFieldHint: undefined,
      });
    }
  });

  it("redacts known request values and generic PII from a MISSING_PARAMETER diagnostic message", async () => {
    vi.stubEnv("CHARIPAY_ENV", "sandbox");
    const leakedUuid = "123e4567-e89b-12d3-a456-426614174000";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({
        error: {
          code: "MISSING_PARAMETER",
          message: `Missing required merchant field. refund=refund-sensitive reason=test email=buyer@example.com url=https://example.com/x uuid=${leakedUuid}`,
        },
        correlationId: "corr-redacted-message",
      }, 400)),
    );

    try {
      await new ChariPayProvider().refund({
        providerPaymentId: "ps-sensitive",
        paymentExternalId: "payment-sensitive",
        amountCents: 500,
        currency: "MAD",
        reason: "test",
        idempotencyKey: "refund-sensitive",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      const providerError = error as ProviderRequestError;
      expect(providerError.message).toBe("ChariPay request failed (MISSING_PARAMETER)");
      expect(providerError.message).not.toContain("buyer@example.com");
      expect(providerError.message).not.toContain("refund-sensitive");
      expect(providerError.providerMessageHint).toBe(
        "Missing required merchant field. refund=<redacted> reason=<redacted> email=<email> url=<url> uuid=<uuid>",
      );
      expect(providerError.providerMessageHint).not.toContain("refund-sensitive");
      expect(providerError.providerMessageHint).not.toContain("buyer@example.com");
      expect(providerError.providerMessageHint).not.toContain(leakedUuid);
    }
  });

  it("never exposes a providerMessageHint outside the ChariPay sandbox", async () => {
    vi.stubEnv("CHARIPAY_ENV", "live");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({
        error: { code: "MISSING_PARAMETER", message: "Missing required merchant field" },
        correlationId: "corr-live-no-message-hint",
      }, 400)),
    );

    try {
      await new ChariPayProvider().refund({
        providerPaymentId: "ps-live",
        paymentExternalId: "payment-live",
        amountCents: 1000,
        currency: "MAD",
        reason: "test",
        idempotencyKey: "refund-live",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect((error as ProviderRequestError).providerMessageHint).toBeUndefined();
    }
  });

  it("parses the provider's own machine error code onto providerCode for diagnostics", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(response({ error: { code: "ORIGINAL_PAYMENT_NOT_FOUND", message: "no matching payment" } }, 400)),
    );
    try {
      await new ChariPayProvider().refund({
        providerPaymentId: "ps",
        paymentExternalId: "payment",
        amountCents: 1000,
        currency: "MAD",
        reason: "test",
        idempotencyKey: "refund-not-found",
      });
      throw new Error("expected provider failure");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({ outcomeUnknown: false, status: 400, providerCode: "ORIGINAL_PAYMENT_NOT_FOUND" });
    }
  });
});