import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADMIN_CSRF_HEADER,
  assertAdminCsrf,
  assertAdminCsrfToken,
  assertSameOriginMutation,
  createAdminCsrfToken,
} from "@/lib/auth/adminCsrf";
import { ADMIN_SESSION_COOKIE } from "@/lib/auth/admin";

const originalSecret = process.env.ADMIN_SESSION_SECRET;
const TEST_SECRET = "onlylive-test-admin-session-secret-32-bytes-minimum";

beforeEach(() => {
  process.env.ADMIN_SESSION_SECRET = TEST_SECRET;
});

afterEach(() => {
  if (originalSecret === undefined) delete process.env.ADMIN_SESSION_SECRET;
  else process.env.ADMIN_SESSION_SECRET = originalSecret;
});

function mutationRequest({
  sessionToken = "session-token-a",
  csrfToken = createAdminCsrfToken(sessionToken),
  origin = "https://tickets.onlylive.test",
}: {
  sessionToken?: string;
  csrfToken?: string | null;
  origin?: string | null;
} = {}) {
  const headers = new Headers({
    cookie: `${ADMIN_SESSION_COOKIE}=${sessionToken}`,
  });
  if (csrfToken !== null) headers.set(ADMIN_CSRF_HEADER, csrfToken);
  if (origin !== null) headers.set("origin", origin);

  return new NextRequest("https://tickets.onlylive.test/api/admin/logout", {
    method: "POST",
    headers,
  });
}

describe("admin CSRF synchronizer token", () => {
  it("is stable for one session, different across sessions, and does not expose the session token", () => {
    const sessionA = "opaque-session-token-a";
    const sessionB = "opaque-session-token-b";
    const first = createAdminCsrfToken(sessionA);
    const second = createAdminCsrfToken(sessionA);

    expect(first).toBe(second);
    expect(first).not.toBe(createAdminCsrfToken(sessionB));
    expect(first).not.toContain(sessionA);
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("verifies a token independently of transport and rejects cross-session replay", () => {
    const sessionA = "opaque-session-token-a";
    const sessionB = "opaque-session-token-b";
    const tokenA = createAdminCsrfToken(sessionA);

    expect(() => assertAdminCsrfToken(sessionA, tokenA)).not.toThrow();
    expect(() => assertAdminCsrfToken(sessionB, tokenA)).toThrow("Invalid CSRF token");
    expect(() => assertAdminCsrfToken(sessionA, undefined)).toThrow("CSRF token is required");
  });

  it("accepts a same-origin request with the token derived from its session", () => {
    expect(() => assertAdminCsrf(mutationRequest())).not.toThrow();
  });

  it("rejects a missing or mismatched token", () => {
    expect(() => assertAdminCsrf(mutationRequest({ csrfToken: null }))).toThrow("CSRF token is required");
    expect(() => assertAdminCsrf(mutationRequest({ csrfToken: "not-the-right-token" }))).toThrow("Invalid CSRF token");
  });

  it("rejects a valid token sent from a different origin", () => {
    expect(() => assertAdminCsrf(mutationRequest({ origin: "https://attacker.example" }))).toThrow(
      "Cross-origin request rejected",
    );
  });
});

describe("pre-authentication same-origin guard", () => {
  it("accepts the application origin without requiring an admin session", () => {
    const request = new NextRequest("https://tickets.onlylive.test/api/admin/login", {
      method: "POST",
      headers: { origin: "https://tickets.onlylive.test" },
    });
    expect(() => assertSameOriginMutation(request)).not.toThrow();
  });

  it("compares the full origin, including scheme", () => {
    const request = new NextRequest("https://tickets.onlylive.test/api/admin/login", {
      method: "POST",
      headers: { origin: "http://tickets.onlylive.test" },
    });
    expect(() => assertSameOriginMutation(request)).toThrow("Cross-origin request rejected");
  });

  it("accepts Vercel's documented forwarding-header shape", () => {
    const request = new NextRequest("https://onlylive-events.vercel.app/api/admin/login", {
      method: "POST",
      headers: {
        host: "onlylive-events.vercel.app",
        "x-forwarded-host": "onlylive-events.vercel.app",
        "x-forwarded-proto": "https",
        origin: "https://onlylive-events.vercel.app",
      },
    });
    expect(() => assertSameOriginMutation(request)).not.toThrow();
  });

  it("honors a reverse proxy's public host and protocol when reconstructing the public origin", () => {
    const request = new NextRequest("http://internal:3000/api/admin/login", {
      method: "POST",
      headers: {
        host: "internal:3000",
        "x-forwarded-host": "tickets.onlylive.test",
        "x-forwarded-proto": "https",
        origin: "https://tickets.onlylive.test",
      },
    });
    expect(() => assertSameOriginMutation(request)).not.toThrow();
  });

  it("rejects cross-site Fetch Metadata and requests with no source origin", () => {
    const crossSite = new NextRequest("https://tickets.onlylive.test/api/admin/login", {
      method: "POST",
      headers: {
        origin: "https://tickets.onlylive.test",
        "sec-fetch-site": "cross-site",
      },
    });
    expect(() => assertSameOriginMutation(crossSite)).toThrow("Cross-site request rejected");

    const missingOrigin = new NextRequest("https://tickets.onlylive.test/api/admin/login", { method: "POST" });
    expect(() => assertSameOriginMutation(missingOrigin)).toThrow("Request origin is required");
  });
});
