import "server-only";
import { prisma } from "@/lib/db";

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
}

/**
 * Fixed-window rate limiter backed by Postgres — the only durable shared
 * store this app has (no Redis/external cache), and correctness across
 * concurrent requests and multiple serverless instances needs a shared
 * store; an in-process counter would not be shared across separate
 * Vercel function invocations. Uses the same
 * INSERT ... ON CONFLICT DO UPDATE ... RETURNING idiom already used for
 * payment_events/email_logs idempotency, so the increment is atomic even
 * under concurrent requests racing on the same key.
 *
 * `key` is caller-chosen and should already include both the action and
 * the identity being limited, e.g. "register:203.0.113.7" — this module
 * has no opinion on what's being limited or by what.
 *
 * Returns true if the caller is within the limit for the current window
 * (the action should proceed), false if the limit has been exceeded (the
 * action should be rejected). Buckets for past windows are never cleaned
 * up here — the table grows unbounded over time; see TASKS.md.
 */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<boolean> {
  if (process.env.RATE_LIMITING_DISABLED === "true") {
    // Only ever set for the Playwright e2e webServer (see
    // playwright.config.ts) — a real browser test suite legitimately
    // performs many distinct logins/registrations that all originate
    // from one local machine with no reverse proxy in front of it, so
    // they'd otherwise collapse into a single "unknown" IP bucket and
    // trip these limits. Never set this for a real deployment.
    return true;
  }

  const windowStart = new Date(Math.floor(Date.now() / options.windowMs) * options.windowMs);

  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO rate_limit_buckets (key, window_start, count)
    VALUES (${key}, ${windowStart}, 1)
    ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limit_buckets.count + 1
    RETURNING count
  `;
  const count = rows[0]?.count ?? 1;
  return count <= options.limit;
}

/**
 * Best-effort client IP extraction from the de-facto standard proxy
 * header. Vercel (the deployment target) and most reverse proxies set
 * this; it can be spoofed by a direct client if nothing in front of the
 * app strips/overwrites it, but that's true of any header-based IP
 * detection and is an accepted limitation, not unique to rate limiting.
 */
export function getClientIp(headers: { get(name: string): string | null } | Record<string, unknown> | undefined): string {
  if (!headers) return "unknown";
  const raw =
    typeof (headers as { get?: unknown }).get === "function"
      ? (headers as { get(name: string): string | null }).get("x-forwarded-for")
      : ((headers as Record<string, unknown>)["x-forwarded-for"] as string | string[] | undefined);
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return "unknown";
  // x-forwarded-for is a comma-separated list; the first entry is the
  // original client.
  return value.split(",")[0]!.trim() || "unknown";
}
