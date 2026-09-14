import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE } from "@/lib/auth/admin";
import { ApiError } from "@/lib/http/errors";

export const ADMIN_CSRF_HEADER = "x-csrf-token";

const CSRF_CONTEXT = "onlylive-admin-csrf-v1\0";

function adminSessionSecret(): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not set");
  }
  return secret;
}

/**
 * Per-session synchronizer token. It is derived from the opaque admin
 * session token with a domain-separated HMAC, so no additional database
 * state or JavaScript-readable cookie is required. The raw session token
 * remains httpOnly and is never exposed to the client.
 */
export function createAdminCsrfToken(sessionToken: string): string {
  return crypto
    .createHmac("sha256", adminSessionSecret())
    .update(CSRF_CONTEXT)
    .update(sessionToken)
    .digest("base64url");
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && crypto.timingSafeEqual(leftBytes, rightBytes);
}

function requestSourceOrigin(request: NextRequest): string | null {
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") return origin;

  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

function targetOrigin(request: NextRequest): string {
  const forwardedHost = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || request.headers.get("host") || request.nextUrl.host;
  const forwardedProto = request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  const protocol = forwardedProto || request.nextUrl.protocol.replace(/:$/, "").toLowerCase();

  if (protocol !== "http" && protocol !== "https") {
    throw new ApiError(403, "CSRF_REJECTED", "Invalid request target origin");
  }

  try {
    // URL canonicalization removes default ports and gives us a full origin
    // comparison (scheme + host + port), not just a host comparison.
    return new URL(`${protocol}://${host}`).origin.toLowerCase();
  } catch {
    throw new ApiError(403, "CSRF_REJECTED", "Invalid request target origin");
  }
}

/**
 * Reject browser-initiated state changes that did not originate from this
 * application. This is also used for the login endpoint, where no admin
 * session exists yet from which to derive a synchronizer token.
 */
export function assertSameOriginMutation(request: NextRequest): void {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    throw new ApiError(403, "CSRF_REJECTED", "Cross-site request rejected");
  }

  const source = requestSourceOrigin(request);
  if (!source) {
    throw new ApiError(403, "CSRF_REJECTED", "Request origin is required");
  }

  let sourceOrigin: string;
  try {
    sourceOrigin = new URL(source).origin.toLowerCase();
  } catch {
    throw new ApiError(403, "CSRF_REJECTED", "Invalid request origin");
  }

  if (sourceOrigin !== targetOrigin(request)) {
    throw new ApiError(403, "CSRF_REJECTED", "Cross-origin request rejected");
  }
}

/**
 * Protect custom cookie-authenticated admin/scanner Route Handlers. Server
 * Actions are intentionally not wrapped here: Next.js already performs its
 * own Origin-vs-Host CSRF validation for Server Actions, while every action
 * still re-checks authorization in application code.
 */
export function assertAdminCsrf(request: NextRequest): void {
  assertSameOriginMutation(request);

  const sessionToken = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  const supplied = request.headers.get(ADMIN_CSRF_HEADER);
  if (!sessionToken || !supplied) {
    throw new ApiError(403, "CSRF_REJECTED", "CSRF token is required");
  }

  const expected = createAdminCsrfToken(sessionToken);
  if (!constantTimeEqual(expected, supplied)) {
    throw new ApiError(403, "CSRF_REJECTED", "Invalid CSRF token");
  }
}

/**
 * Expose only the derived synchronizer token to authenticated server-rendered
 * pages. The httpOnly session cookie itself never crosses the server/client
 * boundary.
 */
export async function getAdminCsrfTokenForPage(): Promise<string> {
  const cookieStore = await cookies();
  const sessionToken = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!sessionToken) {
    throw new ApiError(401, "UNAUTHENTICATED", "Admin sign-in required");
  }
  return createAdminCsrfToken(sessionToken);
}
