import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isInternalRequestAuthorized } from "@/lib/http/internalAuth";

function requestWithHeaders(headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/internal/dispatch-emails", {
    method: "POST",
    headers,
  });
}

describe("isInternalRequestAuthorized", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts a matching X-Internal-Secret header", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "internal-secret-value");
    vi.stubEnv("CRON_SECRET", "");
    expect(isInternalRequestAuthorized(requestWithHeaders({ "x-internal-secret": "internal-secret-value" }))).toBe(true);
  });

  it("accepts Vercel Cron's Authorization: Bearer <CRON_SECRET> header", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
    expect(isInternalRequestAuthorized(requestWithHeaders({ authorization: "Bearer cron-secret-value" }))).toBe(true);
  });

  it("rejects a wrong or missing credential on either path", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "internal-secret-value");
    vi.stubEnv("CRON_SECRET", "cron-secret-value");
    expect(isInternalRequestAuthorized(requestWithHeaders({ "x-internal-secret": "wrong" }))).toBe(false);
    expect(isInternalRequestAuthorized(requestWithHeaders({ authorization: "Bearer wrong" }))).toBe(false);
    expect(isInternalRequestAuthorized(requestWithHeaders({}))).toBe(false);
  });

  it("rejects both headers when neither secret is configured", () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "");
    expect(isInternalRequestAuthorized(requestWithHeaders({ "x-internal-secret": "", authorization: "Bearer " }))).toBe(false);
  });
});
