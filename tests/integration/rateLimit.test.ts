import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import {
  buildRateLimitKey,
  checkRateLimit,
  consumeRateLimit,
  getClientIp,
  inspectRateLimit,
  pruneRateLimitBuckets,
  rateLimitHeaders,
} from "@/lib/rateLimit";

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
    const options = { limit: 1, windowMs: 60_000 };
    const firstWindow = Math.floor(Date.now() / options.windowMs) * options.windowMs + 1;
    const clock = vi.spyOn(Date, "now").mockReturnValue(firstWindow);

    try {
      expect(await checkRateLimit(key, options)).toBe(true);
      expect(await checkRateLimit(key, options)).toBe(false);

      clock.mockReturnValue(firstWindow + options.windowMs);
      expect(await checkRateLimit(key, options)).toBe(true);
    } finally {
      clock.mockRestore();
    }
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

  it("caps a rejected bucket and returns actionable reset headers", async () => {
    const key = `test-${crypto.randomUUID()}`;
    const first = await consumeRateLimit(key, { limit: 1, windowMs: 60_000 });
    const rejected = await consumeRateLimit(key, { limit: 1, windowMs: 60_000 });
    await consumeRateLimit(key, { limit: 1, windowMs: 60_000 });

    expect(first).toMatchObject({ allowed: true, remaining: 0, retryAfterSeconds: 0 });
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
    expect(rateLimitHeaders(rejected)["Retry-After"]).toBe(String(rejected.retryAfterSeconds));

    const bucket = await prisma.rateLimitBucket.findFirstOrThrow({ where: { key } });
    expect(bucket.count).toBe(2);
  });

  it("can inspect a bucket without consuming it", async () => {
    const key = `inspect-${crypto.randomUUID()}`;
    const options = { limit: 1, windowMs: 60_000 };

    expect(await inspectRateLimit(key, options)).toMatchObject({ allowed: true, remaining: 1 });
    expect(await prisma.rateLimitBucket.findFirst({ where: { key } })).toBeNull();

    expect(await consumeRateLimit(key, options)).toMatchObject({ allowed: true, remaining: 0 });
    expect(await inspectRateLimit(key, options)).toMatchObject({ allowed: true, remaining: 0 });

    expect(await consumeRateLimit(key, options)).toMatchObject({ allowed: false, remaining: 0 });
    const blocked = await inspectRateLimit(key, options);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("prunes expired buckets while retaining recent ones", async () => {
    const oldKey = `old-${crypto.randomUUID()}`;
    const freshKey = `fresh-${crypto.randomUUID()}`;
    const oldWindow = new Date(Date.now() - 3 * 24 * 60 * 60 * 1_000);
    const freshWindow = new Date();
    await prisma.rateLimitBucket.createMany({
      data: [
        { key: oldKey, windowStart: oldWindow, count: 1 },
        { key: freshKey, windowStart: freshWindow, count: 1 },
      ],
    });

    const result = await pruneRateLimitBuckets();
    expect(result.deleted).toBeGreaterThanOrEqual(1);
    expect(await prisma.rateLimitBucket.findFirst({ where: { key: oldKey } })).toBeNull();
    expect(await prisma.rateLimitBucket.findFirst({ where: { key: freshKey } })).not.toBeNull();
  });
});

describe("getClientIp", () => {
  it("reads the first address from a comma-separated x-forwarded-for", () => {
    expect(getClientIp({ get: (name) => (name === "x-forwarded-for" ? "203.0.113.7, 10.0.0.1" : null) })).toBe(
      "203.0.113.7",
    );
  });

  it("prefers Vercel's platform-owned forwarding header", () => {
    expect(
      getClientIp({
        "x-vercel-forwarded-for": "203.0.113.10",
        "x-forwarded-for": "198.51.100.4",
      }),
    ).toBe("203.0.113.10");
  });

  it("rejects malformed attacker-selected values and canonicalizes IPv6", () => {
    expect(getClientIp({ "x-forwarded-for": "not-an-ip" })).toBe("unknown");
    expect(getClientIp({ "x-forwarded-for": "fe80::1%eth0" })).toBe("unknown");
    expect(getClientIp({ "x-forwarded-for": "2001:0db8:0000:0000:0000:0000:0000:0001" })).toBe("2001:db8::1");
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

describe("buildRateLimitKey", () => {
  it("is stable and never persists the raw identity", () => {
    const identity = "customer@example.com";
    const first = buildRateLimitKey("customer_login_account", identity);
    const second = buildRateLimitKey("customer_login_account", identity);
    expect(first).toBe(second);
    expect(first).not.toContain(identity);
    expect(first).toMatch(/^customer_login_account:[A-Za-z0-9_-]{43}$/);
  });
});
