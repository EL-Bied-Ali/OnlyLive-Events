import { afterEach, describe, expect, it, vi } from "vitest";
import { assertRateLimitingConfig, buildRateLimitKey, consumeRateLimit } from "@/lib/rateLimit";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("rate-limit production configuration", () => {
  it("allows development without a configured HMAC secret", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "");
    expect(() => assertRateLimitingConfig()).not.toThrow();
    expect(() => buildRateLimitKey("login", "203.0.113.7")).not.toThrow();
  });

  it("rejects production without a strong HMAC secret", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMITING_DISABLED", "false");
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "short");
    expect(() => assertRateLimitingConfig()).toThrow(/at least 32 characters/);
  });

  it("rejects disabling rate limiting in production without explicit test-only opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMITING_DISABLED", "true");
    vi.stubEnv("ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION", "false");
    expect(() => assertRateLimitingConfig()).toThrow(/forbidden in production/);
  });

  it("enforces the production guard even outside the Next.js instrumentation boot path", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMITING_DISABLED", "true");
    vi.stubEnv("ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION", "false");
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "test-only-secret-000000000000000000000000");

    await expect(consumeRateLimit("unit-test", { limit: 1, windowMs: 1_000 })).rejects.toThrow(
      /forbidden in production/,
    );
  });

  it("allows an explicitly opted-in isolated production-mode test server", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RATE_LIMITING_DISABLED", "true");
    vi.stubEnv("ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION", "true");
    vi.stubEnv("RATE_LIMIT_KEY_SECRET", "test-only-secret-000000000000000000000000");
    expect(() => assertRateLimitingConfig()).not.toThrow();
  });
});
