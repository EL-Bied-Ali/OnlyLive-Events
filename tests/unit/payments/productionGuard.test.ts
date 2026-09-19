import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { getPaymentProvider, isFakePaymentsAllowed } from "@/lib/payments";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("fake payments are impossible to enable accidentally in production", () => {
  it("isFakePaymentsAllowed is true outside production regardless of the opt-in flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "");
    expect(isFakePaymentsAllowed()).toBe(true);
  });

  it("isFakePaymentsAllowed is false in production without the explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "");
    expect(isFakePaymentsAllowed()).toBe(false);
  });

  it("isFakePaymentsAllowed is true in production only with the explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "true");
    expect(isFakePaymentsAllowed()).toBe(true);
  });

  it("getPaymentProvider throws in production when PAYMENT_PROVIDER=fake without the opt-in — this is what instrumentation.ts calls at boot to fail startup", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "fake");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "");
    expect(() => getPaymentProvider()).toThrow(/cannot be operated in production/);
  });

  it("getPaymentProvider succeeds in production with the explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "fake");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "true");
    expect(() => getPaymentProvider()).not.toThrow();
  });
});

describe("fake payment routes/pages refuse to operate in production", () => {
  it("the fake webhook route returns 404 in production without the opt-in, before doing anything else", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "");

    const { POST } = await import("@/app/api/payments/webhook/fake/route");
    const request = new NextRequest("http://localhost/api/payments/webhook/fake", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}", // deliberately malformed/empty — must never be reached
    });

    const response = await POST(request);
    expect(response.status).toBe(404);
  });

  it("the fake pay simulate route returns 404 in production without the opt-in, before requiring auth", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "");

    const { POST } = await import("@/app/api/pay/fake/[paymentId]/simulate/route");
    const request = new NextRequest("http://localhost/api/pay/fake/does-not-exist/simulate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ outcome: "succeeded" }),
    });

    // No signed-in session is set up here — if the guard did not run
    // first, this would fail with a 401 from requireCustomer() instead.
    const response = await POST(request, { params: Promise.resolve({ paymentId: "does-not-exist" }) });
    expect(response.status).toBe(404);
  });

  it("the fake pay page calls notFound() in production without the opt-in, before requiring auth", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_FAKE_PAYMENTS_IN_PRODUCTION", "");

    const { default: PayFakePage } = await import("@/app/(customer)/pay/fake/[paymentId]/page");

    await expect(
      PayFakePage({ params: Promise.resolve({ paymentId: "does-not-exist" }) }),
    ).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });
});
