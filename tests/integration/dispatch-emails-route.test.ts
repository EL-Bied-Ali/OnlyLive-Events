import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GET as dispatchEmailsGet,
  POST as dispatchEmailsPost,
} from "@/app/api/internal/dispatch-emails/route";

function request(method: "GET" | "POST", headers: Record<string, string>) {
  return new NextRequest("http://localhost/api/internal/dispatch-emails", {
    method,
    headers,
  });
}

describe("/api/internal/dispatch-emails auth", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a request with no credentials", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await dispatchEmailsPost(request("POST", {}));
    expect(response.status).toBe(401);
  });

  it("accepts POST with X-Internal-Secret for an external scheduler", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "test-internal-secret");
    vi.stubEnv("CRON_SECRET", "");
    const response = await dispatchEmailsPost(request("POST", { "x-internal-secret": "test-internal-secret" }));
    expect(response.status).toBe(200);
  });

  it("accepts POST with Authorization: Bearer <CRON_SECRET>", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await dispatchEmailsPost(request("POST", { authorization: "Bearer test-cron-secret" }));
    expect(response.status).toBe(200);
  });

  // Vercel Cron invokes configured paths with HTTP GET. Having Bearer auth
  // on a POST-only handler is insufficient: adding the route to vercel.json
  // later would otherwise produce 405 Method Not Allowed.
  it("accepts Vercel Cron's GET with Authorization: Bearer <CRON_SECRET>", async () => {
    vi.stubEnv("INTERNAL_API_SECRET", "");
    vi.stubEnv("CRON_SECRET", "test-cron-secret");
    const response = await dispatchEmailsGet(request("GET", { authorization: "Bearer test-cron-secret" }));
    expect(response.status).toBe(200);
  });
});
