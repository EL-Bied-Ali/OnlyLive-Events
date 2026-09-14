import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { POST as registerPost } from "@/app/api/customers/register/route";
import { POST as adminLoginPost } from "@/app/api/admin/login/route";
import { authOptions } from "@/lib/auth/customer";

function withForwardedFor(ip: string, body: unknown, url: string) {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": ip },
    body: JSON.stringify(body),
  });
}

describe("registration rate limiting", () => {
  it("allows 5 registration attempts per IP within the window, then rejects the 6th with 429", async () => {
    const ip = crypto.randomUUID();

    for (let i = 0; i < 5; i += 1) {
      const response = await registerPost(
        withForwardedFor(
          ip,
          {
            email: `ratelimit-register-${crypto.randomUUID()}@test.onlylive.ma`,
            password: "RateLimitTestPassword123!",
            name: "Rate Limit Test",
          },
          "http://localhost/api/customers/register",
        ),
      );
      expect(response.status).toBe(201);
    }

    const sixth = await registerPost(
      withForwardedFor(
        ip,
        { email: `ratelimit-register-${crypto.randomUUID()}@test.onlylive.ma`, password: "RateLimitTestPassword123!", name: "X" },
        "http://localhost/api/customers/register",
      ),
    );
    expect(sixth.status).toBe(429);
    const body = await sixth.json();
    expect(body.error).toBe("RATE_LIMITED");
  });

  it("a different IP is never affected by another IP's exhausted limit", async () => {
    const exhaustedIp = crypto.randomUUID();
    for (let i = 0; i < 5; i += 1) {
      await registerPost(
        withForwardedFor(
          exhaustedIp,
          { email: `ratelimit-other-${crypto.randomUUID()}@test.onlylive.ma`, password: "RateLimitTestPassword123!", name: "X" },
          "http://localhost/api/customers/register",
        ),
      );
    }

    const freshIp = crypto.randomUUID();
    const response = await registerPost(
      withForwardedFor(
        freshIp,
        { email: `ratelimit-fresh-${crypto.randomUUID()}@test.onlylive.ma`, password: "RateLimitTestPassword123!", name: "X" },
        "http://localhost/api/customers/register",
      ),
    );
    expect(response.status).toBe(201);
  });
});

describe("admin login rate limiting", () => {
  it("rejects with 429 (not the credentials check) once the per-IP limit is exceeded — checked before leaking anything about the account", async () => {
    const passwordHash = await hashPassword("AdminRateLimitTest123!");
    const admin = await prisma.adminUser.create({
      data: {
        email: `ratelimit-admin-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash,
        name: "Rate Limit Admin",
        role: "admin",
      },
    });
    const ip = crypto.randomUUID();

    for (let i = 0; i < 5; i += 1) {
      const response = await adminLoginPost(
        withForwardedFor(ip, { email: admin.email, password: "wrong-password" }, "http://localhost/api/admin/login"),
      );
      expect(response.status).toBe(401);
    }

    const sixth = await adminLoginPost(
      // Even the CORRECT password is rejected once the limit is hit —
      // the rate-limit check runs before the credential check.
      withForwardedFor(ip, { email: admin.email, password: "AdminRateLimitTest123!" }, "http://localhost/api/admin/login"),
    );
    expect(sixth.status).toBe(429);
    const body = await sixth.json();
    expect(body.error).toBe("RATE_LIMITED");
  });
});

describe("customer login (authorize) rate limiting", () => {
  it("returns null for wrong credentials up to the limit, then throws RATE_LIMITED", async () => {
    const passwordHash = await hashPassword("CustomerRateLimitTest123!");
    const user = await prisma.user.create({
      data: {
        email: `ratelimit-customer-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash,
        name: "Rate Limit Customer",
      },
    });
    const ip = crypto.randomUUID();
    // next-auth v4's CredentialsProvider() factory returns a stub
    // `authorize: () => null` at the top level and stashes the real
    // config (including our actual authorize function) under `.options`
    // — the framework merges it back at runtime, but calling the
    // provider directly for a test needs to reach past the stub.
    const rawProvider = authOptions.providers[0] as unknown as {
      options: {
        authorize: (
          credentials: { email: string; password: string },
          req: { headers: Record<string, string> },
        ) => Promise<unknown>;
      };
    };
    const authorize = rawProvider.options.authorize;
    const req = { headers: { "x-forwarded-for": ip } };

    for (let i = 0; i < 10; i += 1) {
      const result = await authorize({ email: user.email, password: "wrong-password" }, req);
      expect(result).toBeNull();
    }

    await expect(async () => {
      await authorize({ email: user.email, password: "CustomerRateLimitTest123!" }, req);
    }).rejects.toThrow("RATE_LIMITED");
  });
});
