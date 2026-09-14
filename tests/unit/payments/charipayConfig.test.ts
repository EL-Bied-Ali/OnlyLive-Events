import { afterEach, describe, expect, it, vi } from "vitest";
import { getPaymentProvider } from "@/lib/payments";

function testKey(kind: "test" | "live") {
  return ["chari", "sk", kind, "unit", "placeholder"].join("_");
}

afterEach(() => vi.unstubAllEnvs());

describe("ChariPay configuration guard", () => {
  it("requires an API credential and webhook signing secret", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYMENT_PROVIDER", "charipay");
    vi.stubEnv("CHARIPAY_API_KEY", "");
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "");
    expect(() => getPaymentProvider()).toThrow(/CHARIPAY_API_KEY/);

    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    expect(() => getPaymentProvider()).toThrow(/CHARIPAY_WEBHOOK_SECRET/);
  });

  it("allows a sandbox credential outside production", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYMENT_PROVIDER", "charipay");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "unit-placeholder-secret");
    expect(getPaymentProvider().name).toBe("charipay");
  });

  it("refuses a sandbox credential in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "charipay");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "unit-placeholder-secret");
    expect(() => getPaymentProvider()).toThrow(/live/);
  });

  it("accepts a live-shaped credential in production when webhook signing is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PAYMENT_PROVIDER", "charipay");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("live"));
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "unit-placeholder-secret");
    expect(getPaymentProvider().name).toBe("charipay");
  });
});
