import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { ProviderRequestError } from "@/lib/payments/provider";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("ChariPay expired checkout reconciliation", () => {
  beforeEach(() => {
    vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "checkout-reconcile"].join("_"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("treats a successful cancel as definitive proof the session is non-payable", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { status: "CANCELLED" }, { "x-request-id": "corr-ok" }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await new ChariPayProvider().closePaymentSession("ps_123", "req-123");
    expect(result).toEqual({ state: "non_payable", providerStatus: "CANCELLED", correlationId: "corr-ok", httpStatus: 200 });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-psp.charipay.ma/v1/payment-sessions/ps_123/cancel",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "X-Request-Id": "req-123",
          "X-CHARI-PAY-API-KEY": expect.stringMatching(/^chari_sk_test_/),
        }),
      }),
    );
  });

  it("preserves the real observed status string on a successful cancel instead of a hardcoded value", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, { status: "SESSION_CLOSED" }, { "x-request-id": "corr-observed" })));

    await expect(new ChariPayProvider().closePaymentSession("ps_observed", "req-observed")).resolves.toEqual({
      state: "non_payable",
      providerStatus: "SESSION_CLOSED",
      correlationId: "corr-observed",
      httpStatus: 200,
    });
  });

  it("still returns non_payable when a successful cancel has an empty or non-JSON body", async () => {
    const emptyBody = new Response("", { status: 200, headers: { "x-request-id": "corr-empty" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(emptyBody));
    await expect(new ChariPayProvider().closePaymentSession("ps_empty", "req-empty")).resolves.toEqual({
      state: "non_payable",
      providerStatus: "CANCELLED",
      correlationId: "corr-empty",
      httpStatus: 200,
    });

    const nonJsonBody = new Response("not json", { status: 200, headers: { "x-request-id": "corr-nonjson" } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(nonJsonBody));
    await expect(new ChariPayProvider().closePaymentSession("ps_nonjson", "req-nonjson")).resolves.toEqual({
      state: "non_payable",
      providerStatus: "CANCELLED",
      correlationId: "corr-nonjson",
      httpStatus: 200,
    });
  });

  it("treats SESSION_EXPIRED as non-payable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(410, {
      error: { code: "SESSION_EXPIRED", message: "expired" },
    })));

    await expect(new ChariPayProvider().closePaymentSession("ps_expired", "req-expired")).resolves.toMatchObject({
      state: "non_payable",
      providerStatus: "SESSION_EXPIRED",
      httpStatus: 410,
      providerCode: "SESSION_EXPIRED",
    });
  });

  it.each([
    [409, "SESSION_ALREADY_CONSUMED"],
    [409, "SESSION_NOT_ACTIVE"],
    [404, "SESSION_NOT_FOUND"],
  ])("keeps inventory fail-closed for ambiguous %s %s", async (status, code) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(status, {
      error: { code, message: "ambiguous" },
    }, { "x-request-id": `corr-${code}` })));

    await expect(new ChariPayProvider().closePaymentSession("ps_ambiguous", "req-ambiguous")).resolves.toMatchObject({
      state: "unknown",
      providerStatus: code,
      httpStatus: status,
      providerCode: code,
    });
  });

  it("propagates Retry-After on a rate-limited cancel without declaring the session safe to release", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(429, {
      error: { code: "RATE_LIMITED", message: "slow down" },
    }, { "retry-after": "7", "x-request-id": "corr-rate" })));

    try {
      await new ChariPayProvider().closePaymentSession("ps_rate", "req-rate");
      throw new Error("expected closePaymentSession to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderRequestError);
      expect(error).toMatchObject({
        outcomeUnknown: true,
        status: 429,
        retryAfterMs: 7_000,
        correlationId: "corr-rate",
      });
    }
  });
  it("recovers an exact successful payment from ChariPay's transaction ledger", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, {
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
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new ChariPayProvider().lookupPaymentStatus({
      orderExternalId: "order-123",
      amountCents: 1000,
      currency: "MAD",
    })).resolves.toEqual({
      status: "succeeded",
      providerOperationId: "281",
      providerStatus: "SUCCESS",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api-psp.charipay.ma/v1/transactions?type=PAYMENT&search=order-123&limit=50",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          "X-CHARI-PAY-API-KEY": expect.stringMatching(/^chari_sk_test_/),
        }),
      }),
    );
  });

  it("fails closed when the transaction ledger match is ambiguous or immutable facts differ", async () => {
    const provider = new ChariPayProvider();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {
      data: [{
        operationId: 281,
        type: "PAYMENT",
        status: "SUCCESS",
        amount: 9.99,
        currency: "MAD",
        direction: "IN",
        externalReference: "order-123",
      }],
      hasMore: false,
    })));
    await expect(provider.lookupPaymentStatus({
      orderExternalId: "order-123",
      amountCents: 1000,
      currency: "MAD",
    })).resolves.toMatchObject({ status: "ambiguous", providerOperationId: "281" });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {
      data: [
        { operationId: 281, externalReference: "order-123" },
        { operationId: 282, externalReference: "order-123" },
      ],
      hasMore: false,
    })));
    await expect(provider.lookupPaymentStatus({
      orderExternalId: "order-123",
      amountCents: 1000,
      currency: "MAD",
    })).resolves.toEqual({
      status: "ambiguous",
      providerStatus: "MULTIPLE_EXACT_MATCHES",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {
      data: [],
      hasMore: true,
      nextCursor: "cursor",
    })));
    await expect(provider.lookupPaymentStatus({
      orderExternalId: "order-123",
      amountCents: 1000,
      currency: "MAD",
    })).resolves.toEqual({
      status: "ambiguous",
      providerStatus: "SEARCH_TRUNCATED",
    });
  });

  it("maps pending and not-found ledger results without claiming payment success", async () => {
    const provider = new ChariPayProvider();

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {
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
    })));
    await expect(provider.lookupPaymentStatus({
      orderExternalId: "order-pending",
      amountCents: 1000,
      currency: "MAD",
    })).resolves.toMatchObject({
      status: "pending",
      providerOperationId: "300",
      providerStatus: "PENDING_3DS",
    });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {
      data: [],
      hasMore: false,
    })));
    await expect(provider.lookupPaymentStatus({
      orderExternalId: "order-missing",
      amountCents: 1000,
      currency: "MAD",
    })).resolves.toEqual({ status: "not_found" });
  });

  it("rejects a malformed transaction list instead of guessing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {
      content: [],
    })));

    await expect(new ChariPayProvider().lookupPaymentStatus({
      orderExternalId: "order-123",
      amountCents: 1000,
      currency: "MAD",
    })).rejects.toMatchObject({
      name: "ProviderRequestError",
      outcomeUnknown: true,
    });
  });

});
