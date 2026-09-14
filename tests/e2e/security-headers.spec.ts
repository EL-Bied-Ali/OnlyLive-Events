import { test, expect } from "@playwright/test";

test("pages expose the baseline browser security headers", async ({ request }) => {
  const response = await request.get("/");
  expect(response.ok()).toBe(true);

  const csp = response.headers()["content-security-policy"];
  expect(csp).toContain("default-src 'self'");
  expect(csp).toContain("object-src 'none'");
  expect(csp).toContain("base-uri 'self'");
  expect(csp).toContain("form-action 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("frame-src 'none'");

  expect(response.headers()["x-content-type-options"]).toBe("nosniff");
  expect(response.headers()["referrer-policy"]).toBe("strict-origin-when-cross-origin");
  expect(response.headers()["permissions-policy"]).toContain("camera=(self)");
  expect(response.headers()["permissions-policy"]).toContain("microphone=()");
});

test("admin login rejects a forged cross-origin POST before credential processing", async ({ request }) => {
  const response = await request.post("/api/admin/login", {
    headers: { origin: "https://attacker.example" },
    data: { email: "nobody@example.com", password: "not-a-real-password" },
  });

  expect(response.status()).toBe(403);
  expect(await response.json()).toMatchObject({ error: "CSRF_REJECTED" });
});
