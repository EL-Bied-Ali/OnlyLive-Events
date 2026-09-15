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
    expect(result).toEqual({ state: "non_payable", providerStatus: "CANCELLED", correlationId: "corr-ok" });
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

  it("treats SESSION_EXPIRED as non-payable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(410, {
      error: { code: "SESSION_EXPIRED", message: "expired" },
    })));

    await expect(new ChariPayProvider().closePaymentSession("ps_expired", "req-expired")).resolves.toMatchObject({
      state: "non_payable",
      providerStatus: "SESSION_EXPIRED",
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
});
