import "server-only";

const LOCAL_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/**
 * Single source of truth for building absolute application URLs (e.g. a
 * ticket/order link inside a transactional email, where a relative path
 * is meaningless outside a browser tab already on the app). Reuses
 * NEXTAUTH_URL — already a required env var describing this deployment's
 * own public URL — rather than introducing a second, easily-desynced one.
 *
 * Requires https in production. The only exception is an explicit
 * E2E-only opt-in for a local-loopback URL: Playwright deliberately runs
 * `next start` (always NODE_ENV=production) against
 * `http://localhost:PORT` with no reverse proxy. A loopback hostname by
 * itself is never enough to weaken the production invariant.
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

  if (process.env.NODE_ENV === "production" && url.protocol !== "https:") {
    const explicitLoopbackE2e =
      LOCAL_HOSTNAMES.has(url.hostname)
      && process.env.ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION === "true";

    if (!explicitLoopbackE2e) {
      throw new Error(
        `NEXTAUTH_URL must use https in production (got "${raw}"). HTTP loopback is allowed only with ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION=true for isolated E2E runs.`,
      );
    }
  }

  return url.origin;
}

/** Resolves `path` against the app's own base URL — never trusts a caller-supplied origin. */
export function absoluteAppUrl(path: string): string {
  return new URL(path, getAppBaseUrl()).toString();
}
