import "server-only";
import crypto from "node:crypto";
import { isIP } from "node:net";
import { prisma } from "@/lib/db";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

export interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: Date;
  retryAfterSeconds: number;
}

const DEVELOPMENT_KEY_SECRET = "onlylive-rate-limit-development-key-never-use-in-production";
export const RATE_LIMIT_RETENTION_MS = 48 * 60 * 60 * 1000;

function keySecret(): string {
  const configured = process.env.RATE_LIMIT_KEY_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new Error("RATE_LIMIT_KEY_SECRET is required in production");
  }
  return DEVELOPMENT_KEY_SECRET;
}

/**
 * Fail fast when a production deployment accidentally disables the only
 * application-level credential-abuse protection or would persist unhashed
 * identities because its HMAC key is missing. Playwright's production-mode
 * webServer must opt in explicitly; real customer deployments must not.
 */
export function assertRateLimitingConfig(): void {
  if (process.env.NODE_ENV !== "production") return;

  if (
    process.env.RATE_LIMITING_DISABLED === "true" &&
    process.env.ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION !== "true"
  ) {
    throw new Error(
      "RATE_LIMITING_DISABLED=true is forbidden in production unless ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION=true is explicitly set for an isolated non-customer test deployment",
    );
  }

  const secret = process.env.RATE_LIMIT_KEY_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("RATE_LIMIT_KEY_SECRET must be set to at least 32 characters in production");
  }
}

/** Persist only a deterministic HMAC, never a raw IP address or email. */
export function buildRateLimitKey(scope: string, identity: string): string {
  if (!/^[a-z0-9_:-]{1,64}$/i.test(scope)) {
    throw new Error("Invalid rate-limit scope");
  }
  return `${scope}:${crypto.createHmac("sha256", keySecret()).update(identity).digest("base64url")}`;
}

function validateOptions(options: RateLimitOptions): void {
  if (!Number.isSafeInteger(options.limit) || options.limit < 1) {
    throw new Error("Rate-limit limit must be a positive integer");
  }
  if (!Number.isSafeInteger(options.windowMs) || options.windowMs < 1) {
    throw new Error("Rate-limit windowMs must be a positive integer");
  }
}

/**
 * Fixed-window limiter backed by Postgres. The atomic upsert works across
 * serverless instances. The counter is capped at limit + 1 so rejected
 * traffic cannot overflow the integer or create ever-growing values.
 */
export async function consumeRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  validateOptions(options);
  // Keep the startup validation in instrumentation.ts for fail-fast
  // deployments, but enforce it here too in case this helper is ever used
  // outside the normal Next.js boot path (tests, scripts, or another worker).
  assertRateLimitingConfig();
  const now = Date.now();
  const windowStartMs = Math.floor(now / options.windowMs) * options.windowMs;
  const resetAt = new Date(windowStartMs + options.windowMs);

  if (process.env.RATE_LIMITING_DISABLED === "true") {
    return { allowed: true, limit: options.limit, remaining: options.limit, resetAt, retryAfterSeconds: 0 };
  }

  const windowStart = new Date(windowStartMs);
  const cappedCount = options.limit + 1;
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE
      SET count = LEAST(rate_limit_buckets.count + 1, ${cappedCount})
    RETURNING count
  `;
  const count = rows[0]?.count ?? 1;
  const allowed = count <= options.limit;

  return {
    allowed,
    limit: options.limit,
    remaining: Math.max(0, options.limit - count),
    resetAt,
    retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((resetAt.getTime() - now) / 1000)),
  };
}

/** Compatibility helper for callers/tests that only need allow/deny. */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<boolean> {
  return (await consumeRateLimit(key, options)).allowed;
}

export function rateLimitHeaders(result: RateLimitResult): Record<string, string> {
  return {
    "Retry-After": String(result.retryAfterSeconds),
    "X-RateLimit-Limit": String(result.limit),
    "X-RateLimit-Remaining": String(result.remaining),
    "X-RateLimit-Reset": String(Math.ceil(result.resetAt.getTime() / 1000)),
  };
}

function readHeader(
  headers: { get(name: string): string | null } | Record<string, unknown>,
  name: string,
): string | string[] | undefined {
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name) ?? undefined;
  }
  const entry = Object.entries(headers as Record<string, unknown>).find(([key]) => key.toLowerCase() === name);
  const value = entry?.[1];
  return typeof value === "string" || (Array.isArray(value) && value.every((part) => typeof part === "string"))
    ? (value as string | string[])
    : undefined;
}

function normalizeIp(raw: string): string | null {
  const candidate = raw.split(",")[0]!.trim();
  const version = isIP(candidate);
  if (version === 4) return candidate;
  if (version !== 6) return null;

  // URL's IPv6 host parser canonicalizes equivalent textual forms, stopping
  // one address from obtaining multiple buckets by changing zero padding.
  // Zone identifiers are not valid forwarding-header client identities and
  // Node's URL parser rejects them even though net.isIP accepts them.
  if (candidate.includes("%")) return null;
  try {
    const hostname = new URL(`http://[${candidate}]/`).hostname;
    return hostname.slice(1, -1).toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolve only syntactically valid IPs. Vercel's platform-owned header is
 * preferred because x-forwarded-for can be replaced by an external proxy.
 * Invalid/missing values collapse into one conservative "unknown" bucket
 * instead of becoming attacker-selected database keys.
 */
export function getClientIp(
  headers: { get(name: string): string | null } | Record<string, unknown> | undefined,
): string {
  if (!headers) return "unknown";
  for (const name of ["x-vercel-forwarded-for", "x-forwarded-for"]) {
    const raw = readHeader(headers, name);
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (!value) continue;
    const normalized = normalizeIp(value);
    if (normalized) return normalized;
  }
  return "unknown";
}

/** Delete expired buckets; intended for the authenticated housekeeping job. */
export async function pruneRateLimitBuckets(retentionMs = RATE_LIMIT_RETENTION_MS): Promise<{ deleted: number }> {
  if (!Number.isSafeInteger(retentionMs) || retentionMs < 1) {
    throw new Error("Rate-limit retentionMs must be a positive integer");
  }
  const result = await prisma.rateLimitBucket.deleteMany({
    where: { windowStart: { lt: new Date(Date.now() - retentionMs) } },
  });
  return { deleted: result.count };
}
