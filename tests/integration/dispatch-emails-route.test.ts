import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POST as dispatchEmailsPost } from "@/app/api/internal/dispatch-emails/route";

function request(headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/internal/dispatch-emails", {
    method: "POST",
    headers,
  });
}

describe("POST /api/internal/dispatch-emails auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a request with no credentials", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await dispatchEmailsPost(request({}));
    expect(response.status).toBe(401);
  });

  it("accepts X-Internal-Secret", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
    vi.stubEnv("CRON_SECRET", "");
    const response = await dispatchEmailsPost(request({ "x-internal-secret": "test-internal-secret" }));
    expect(response.status).toBe(200);
  });

  // The fix this test locks in: dispatch-emails previously only accepted
  // X-Internal-Secret, unlike sweep-expired-holds — meaning it could never
  // be wired into Vercel's native cron (which sends this header, not
  // X-Internal-Secret) even once a paid plan allowed a frequent-enough
  // schedule. Found during the PR #13 merge audit.
  it("accepts Vercel Cron's Authorization: Bearer <CRON_SECRET>, matching sweep-expired-holds", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await dispatchEmailsPost(request({ authorization: "Bearer test-cron-secret" }));
    expect(response.status).toBe(200);
  });
});
