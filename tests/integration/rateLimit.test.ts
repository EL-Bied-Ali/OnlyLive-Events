import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

describe("checkRateLimit", () => {
  it("allows exactly `limit` calls within a window and rejects the next", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const options = { limit: 3, windowMs: 60_000 };

    expect(await checkRateLimit(key, options)).toBe(true);
    expect(await checkRateLimit(key, options)).toBe(true);
    expect(await checkRateLimit(key, options)).toBe(true);
    expect(await checkRateLimit(key, options)).toBe(false);
    expect(await checkRateLimit(key, options)).toBe(false);
  });

  it("resets once a new window starts", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const options = { limit: 1, windowMs: 50 };

    expect(await checkRateLimit(key, options)).toBe(true);
    expect(await checkRateLimit(key, options)).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(await checkRateLimit(key, options)).toBe(true);
  });

  it("different keys never share a bucket", async () => {
    const keyA = `test-${crypto.randomUUID()}`;
    const keyB = `test-${crypto.randomUUID()}`;
    const options = { limit: 1, windowMs: 60_000 };

    expect(await checkRateLimit(keyA, options)).toBe(true);
    expect(await checkRateLimit(keyB, options)).toBe(true);
    expect(await checkRateLimit(keyA, options)).toBe(false);
    expect(await checkRateLimit(keyB, options)).toBe(false);
  });

  it("is atomic under concurrent calls on the same key — never lets more than `limit` through", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const options = { limit: 5, windowMs: 60_000 };

    const results = await Promise.all(Array.from({ length: 12 }, () => checkRateLimit(key, options)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});

describe("getClientIp", () => {
  it("reads the first address from a comma-separated x-forwarded-for", () => {
    expect(getClientIp({ get: (name) => (name === "x-forwarded-for" ? "203.0.113.7, 10.0.0.1" : null) })).toBe(
      "203.0.113.7",
    );
  });

  it("works with a plain headers object (next-auth's authorize() req shape)", () => {
    expect(getClientIp({ "x-forwarded-for": "198.51.100.4" })).toBe("198.51.100.4");
  });

  it("falls back to 'unknown' when absent", () => {
    expect(getClientIp({ get: () => null })).toBe("unknown");
    expect(getClientIp(undefined)).toBe("unknown");
    expect(getClientIp({})).toBe("unknown");
  });
});
