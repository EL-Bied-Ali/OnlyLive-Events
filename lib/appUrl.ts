import "server-only";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Single source of truth for building absolute application URLs (e.g. a
 * ticket/order link inside a transactional email, where a relative path
 * is meaningless outside a browser tab already on the app). Reuses
 * NEXTAUTH_URL — already a required env var describing this deployment's
 * own public URL — rather than introducing a second, easily-desynced one.
 *
 * Requires https in production, except for local-loopback hostnames: the
 * Playwright e2e suite deliberately runs `next start` (always
 * NODE_ENV=production) against `http://localhost:PORT` with no reverse
 * proxy (see playwright.config.ts) — this is exactly the
 * non-production-traffic case this exemption exists for, never a real
 * deployment.
 */
export function getAppBaseUrl(): string {
  const raw = process.env.NEXTAUTH_URL;
  if (!raw) {
    throw new Error("NEXTAUTH_URL is not set — required to build absolute application URLs.");
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`NEXTAUTH_URL must be a valid URL (got "${raw}").`);
  }

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:" && !LOCAL_HOSTNAMES.has(url.hostname)) {
    throw new Error(
      `NEXTAUTH_URL must use https in production (got "${raw}"). Local loopback hosts are exempt only for non-production-traffic runs (e.g. the Playwright e2e suite's next start).`,
    );
  }

  return url.origin;
}

/** Resolves `path` against the app's own base URL — never trusts a caller-supplied origin. */
export function absoluteAppUrl(path: string): string {
  return new URL(path, getAppBaseUrl()).toString();
}
