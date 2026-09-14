import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { ProviderRequestError } from "@/lib/payments/provider";

const API_KEY = "chari_sk_test_hardening-key";
const WEBHOOK_SECRET = "hardening-webhook-secret";

function signedHeaders(rawBody: string, signatureTransform: (value: string) => string = (value) => value) {
  const timestamp = String(Date.now());
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return {
    "x-chari-signature": signatureTransform(signature),
    "x-chari-timestamp": timestamp,
    "chari-event-id": "evt-hardening",
    "chari-event-type": "payment.succeeded",
  };
}

function refundInput(idempotencyKey: string) {
  return {
    providerPaymentId: "ps_123",
    paymentExternalId: "payment-123",
    amountCents: 1_000,
    currency: "MAD",
    reason: "hardening test",
    idempotencyKey,
  };
}

describe("ChariPayProvider hardening", () => {
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

  it("requires an exact 64-character SHA-256 hex signature", async () => {
    const raw = JSON.stringify({ externalId: "payment-123", amount: 10, currency: "MAD" });
    const provider = new ChariPayProvider();

    const exact = await provider.parseWebhook({ rawBody: raw, headers: signedHeaders(raw) });
    expect(exact.signatureValid).toBe(true);

    const uppercase = await provider.parseWebhook({ rawBody: raw, headers: signedHeaders(raw, (value) => value.toUpperCase()) });
    expect(uppercase.signatureValid).toBe(true);

    const plusOneNibble = await provider.parseWebhook({ rawBody: raw, headers: signedHeaders(raw, (value) => `${value}a`) });
    expect(plusOneNibble.signatureValid).toBe(false);

    const plusTwo = await provider.parseWebhook({ rawBody: raw, headers: signedHeaders(raw, (value) => `${value}aa`) });
    expect(plusTwo.signatureValid).toBe(false);

    const nonHex = await provider.parseWebhook({ rawBody: raw, headers: signedHeaders(raw, (value) => `${value.slice(0, 63)}z`) });
    expect(nonHex.signatureValid).toBe(false);
  });

  it("keeps a refund pending when a 2xx response is non-JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not-json", {
      status: 200,
      headers: { "content-type": "text/plain", "x-correlation-id": "corr-2xx" },
    })));

    try {
      await new ChariPayProvider().refund(refundInput("refund-malformed-2xx"));
      throw new Error("expected provider ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({ outcomeUnknown: true, status: 200, correlationId: "corr-2xx" });
    }
  });

  it("treats HTTP 409 idempotency conflicts as ambiguous and preserves retry metadata", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: "IDEMPOTENCY_CONFLICT", message: "reference already exists" },
    }), {
      status: 409,
      headers: {
        "content-type": "application/json",
        "retry-after": "3",
        "x-correlation-id": "corr-409",
      },
    })));

    try {
      await new ChariPayProvider().refund(refundInput("refund-conflict"));
      throw new Error("expected provider ambiguity");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({
        outcomeUnknown: true,
        status: 409,
        retryAfterMs: 3_000,
        correlationId: "corr-409",
      });
    }
  });

  it("treats a malformed successful checkout response as an unknown provider outcome", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ unexpected: true }), {
      status: 201,
      headers: { "content-type": "application/json", "x-request-id": "corr-checkout" },
    })));

    await expect(new ChariPayProvider().createPayment({
      paymentId: "payment-unknown",
      orderId: "order-unknown",
      amountCents: 1_000,
      currency: "MAD",
      idempotencyKey: "payment-unknown",
      customerEmail: "buyer@example.com",
      customerName: "Amine Bennani",
      customerPhone: "+212600000000",
      returnUrl: "https://onlylive.ma/orders/order-unknown",
      webhookUrl: "https://onlylive.ma/api/payments/webhook/charipay",
      expiresAt: new Date(Date.now() + 60_000),
    })).rejects.toMatchObject({ outcomeUnknown: true, status: 201, correlationId: "corr-checkout" });
  });
});
