import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as sweepGet, POST as sweepPost } from "@/app/api/internal/sweep-expired-holds/route";

function request(method: "GET" | "POST", headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/internal/sweep-expired-holds", {
    method,
    headers,
  });
}

describe("/api/internal/sweep-expired-holds auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a request with no credentials", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await sweepPost(request("POST", {}));
    expect(response.status).toBe(401);
  });

  it("accepts POST with X-Internal-Secret for an external scheduler", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
    vi.stubEnv("CRON_SECRET", "");
    const response = await sweepPost(request("POST", { "x-internal-secret": "test-internal-secret" }));
    expect(response.status).toBe(200);
  });

  it("accepts POST with Authorization: Bearer <CRON_SECRET>", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await sweepPost(request("POST", { authorization: "Bearer test-cron-secret" }));
    expect(response.status).toBe(200);
  });

  // Vercel Cron invokes configured paths with HTTP GET, same as
  // dispatch-emails — this route must accept it too, not just POST.
  it("accepts Vercel Cron's GET with Authorization: Bearer <CRON_SECRET>", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await sweepGet(request("GET", { authorization: "Bearer test-cron-secret" }));
    expect(response.status).toBe(200);
  });
});
