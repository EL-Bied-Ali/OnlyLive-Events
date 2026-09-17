import { afterEach, describe, expect, it, vi } from "vitest";
import { getChariPayWebhookUrl, getOnlyLivePublicUrl, getPaymentProvider } from "@/lib/payments";

function testKey(kind: "test" | "live") {
  return ["chari", "sk", kind, "unit", "placeholder"].join("_");
}

function configureBase() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "unit-placeholder-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
  vi.stubEnv("CRON_SECRET", "unit-cron-secret-1234567890");
}

afterEach(() => vi.unstubAllEnvs());

describe("ChariPay configuration guard", () => {
  it("requires API key, signing secret, environment and public origin", () => {
    vi.stubEnv("PAYMENT_PROVIDER", "charipay");
    vi.stubEnv("CHARIPAY_API_KEY", "");
    expect(() => getPaymentProvider()).toThrow(/CHARIPAY_API_KEY/);

    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "");
    expect(() => getPaymentProvider()).toThrow(/CHARIPAY_WEBHOOK_SECRET/);

    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "unit-placeholder-secret");
    vi.stubEnv("CHARIPAY_ENV", "");
    expect(() => getPaymentProvider()).toThrow(/CHARIPAY_ENV/);

    vi.stubEnv("CHARIPAY_ENV", "sandbox");
    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "");
    expect(() => getPaymentProvider()).toThrow(/ONLYLIVE_PUBLIC_URL/);
  });

  it("allows only sandbox credentials on Vercel Preview", () => {
    configureBase();
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "unit-bypass-secret");
    vi.stubEnv("CHARIPAY_ENV", "sandbox");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    expect(getPaymentProvider().name).toBe("charipay");

    vi.stubEnv("CHARIPAY_ENV", "live");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("live"));
    expect(() => getPaymentProvider()).toThrow(/live credentials are forbidden/);
  });

  it("allows only sandbox credentials outside Vercel", () => {
    configureBase();
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("CHARIPAY_ENV", "sandbox");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    expect(getPaymentProvider().name).toBe("charipay");

    vi.stubEnv("CHARIPAY_ENV", "live");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("live"));
    expect(() => getPaymentProvider()).toThrow(/live credentials are forbidden/);
  });

  it("refuses sandbox in Vercel Production and keeps live behind provider verification", () => {
    configureBase();
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHARIPAY_ENV", "sandbox");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    expect(() => getPaymentProvider()).toThrow(/Production requires CHARIPAY_ENV=live/);

    vi.stubEnv("CHARIPAY_ENV", "live");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("live"));
    vi.stubEnv("CHARIPAY_PROVIDER_VERIFIED", "false");
    expect(() => getPaymentProvider()).toThrow(/sandbox verification/);

    vi.stubEnv("CHARIPAY_PROVIDER_VERIFIED", "true");
    vi.stubEnv("CRON_SECRET", "");
    expect(() => getPaymentProvider()).toThrow(/CRON_SECRET/);

    vi.stubEnv("CRON_SECRET", "unit-cron-secret-1234567890");
    expect(getPaymentProvider().name).toBe("charipay");
  });

  it("rejects a live-shaped key in sandbox and a test-shaped key in live", () => {
    configureBase();
    vi.stubEnv("CHARIPAY_ENV", "sandbox");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("live"));
    expect(() => getPaymentProvider()).toThrow(/chari_sk_test_/);

    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("CHARIPAY_ENV", "live");
    vi.stubEnv("CHARIPAY_PROVIDER_VERIFIED", "true");
    vi.stubEnv("CHARIPAY_API_KEY", testKey("test"));
    expect(() => getPaymentProvider()).toThrow(/chari_sk_live_/);
  });

  it("requires a canonical HTTPS public origin", () => {
    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "http://preview.example.com");
    expect(() => getOnlyLivePublicUrl()).toThrow(/HTTPS/);

    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.example.com/path");
    expect(() => getOnlyLivePublicUrl()).toThrow(/origin only/);

    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.example.com/?x=1");
    expect(() => getOnlyLivePublicUrl()).toThrow(/query/);

    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.example.com/");
    expect(getOnlyLivePublicUrl()).toBe("https://preview.example.com");
  });

  it("adds Vercel's automation bypass to the default Preview webhook URL", () => {
    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.example.com/");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "unit bypass/?secret");

    const url = new URL(getChariPayWebhookUrl());
    expect(url.origin).toBe("https://preview.example.com");
    expect(url.pathname).toBe("/api/payments/webhook/charipay");
    expect(url.searchParams.get("x-vercel-protection-bypass")).toBe("unit bypass/?secret");
  });

  it("never auto-attaches the Vercel bypass secret outside Preview", () => {
    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://onlylive.example/");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "must-not-leak");

    expect(getChariPayWebhookUrl()).toBe("https://onlylive.example/api/payments/webhook/charipay");
  });

  it("supports a dedicated HTTPS webhook ingress override", () => {
    vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.example.com/");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "unused-for-explicit-url");
    vi.stubEnv("CHARIPAY_WEBHOOK_URL", "https://relay.example.com/charipay?channel=sandbox");

    expect(getChariPayWebhookUrl()).toBe("https://relay.example.com/charipay?channel=sandbox");

    vi.stubEnv("CHARIPAY_WEBHOOK_URL", "http://relay.example.com/charipay");
    expect(() => getChariPayWebhookUrl()).toThrow(/HTTPS/);
  });
});
