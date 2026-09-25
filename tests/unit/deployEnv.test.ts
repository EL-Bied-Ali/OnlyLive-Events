import { describe, expect, it } from "vitest";
import { deploymentEnvErrors } from "@/lib/deployEnv";

const fakePreview = {
  VERCEL_ENV: "preview",
  DATABASE_URL: "postgresql://example.invalid/db",
  NEXTAUTH_URL: "https://preview.onlylive.example",
  NEXTAUTH_SECRET: "n".repeat(32),
  ADMIN_SESSION_SECRET: "a".repeat(32),
  RATE_LIMIT_KEY_SECRET: "r".repeat(32),
  INTERNAL_API_SECRET: "internal-preview-key",
  PAYMENT_PROVIDER: "fake",
  ALLOW_FAKE_PAYMENTS_IN_PRODUCTION: "true",
  FAKE_PSP_WEBHOOK_SECRET: "f".repeat(16),
  EMAIL_PROVIDER: "console",
  ALLOW_CONSOLE_EMAIL_IN_PRODUCTION: "true",
} satisfies Record<string, string>;

describe("deploymentEnvErrors", () => {
  it("does not constrain local development", () => {
    expect(deploymentEnvErrors({})).toEqual([]);
  });

  it("accepts a fully configured fake-provider preview", () => {
    expect(deploymentEnvErrors(fakePreview)).toEqual([]);
  });

  it("catches configuration that would otherwise fail on first request", () => {
    const errors = deploymentEnvErrors({
      ...fakePreview,
      NEXTAUTH_SECRET: "",
      RATE_LIMIT_KEY_SECRET: "short",
      FAKE_PSP_WEBHOOK_SECRET: "",
    });

    expect(errors).toEqual(expect.arrayContaining([
      "NEXTAUTH_SECRET is required",
      "RATE_LIMIT_KEY_SECRET must be at least 32 characters",
      "FAKE_PSP_WEBHOOK_SECRET is required",
    ]));
  });

  it("forbids live ChariPay credentials on Preview", () => {
    const errors = deploymentEnvErrors({
      ...fakePreview,
      PAYMENT_PROVIDER: "charipay",
      CHARIPAY_ENV: "live",
      CHARIPAY_API_KEY: "chari_sk_live_example",
      CHARIPAY_WEBHOOK_SECRET: "webhook-secret",
      ONLYLIVE_PUBLIC_URL: "https://preview.onlylive.example",
    });

    expect(errors).toContain('Vercel Preview ChariPay requires CHARIPAY_ENV="sandbox"');
  });
});
