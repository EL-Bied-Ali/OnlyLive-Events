import crypto from "node:crypto";
import { expect, test } from "@playwright/test";
import type { APIResponse } from "@playwright/test";

test("the real Auth.js credentials callback surfaces RATE_LIMITED", async ({ request }) => {
  const csrfResponse = await request.get("/api/auth/csrf");
  expect(csrfResponse.ok()).toBe(true);
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
  const email = `e2e-rate-limit-${crypto.randomUUID()}@test.onlylive.ma`;

  let lastResponse: APIResponse | undefined;
  for (let i = 0; i < 11; i += 1) {
    lastResponse = await request.post("/api/auth/callback/credentials", {
      form: {
        csrfToken,
        email,
        password: "always-wrong-password",
        callbackUrl: "http://localhost/login",
        json: "true",
      },
    });
  }

  expect(lastResponse).toBeDefined();
  expect(lastResponse!.status()).toBe(401);
  const body = (await lastResponse!.json()) as { url: string };
  expect(new URL(body.url).searchParams.get("error")).toBe("RATE_LIMITED");
});
