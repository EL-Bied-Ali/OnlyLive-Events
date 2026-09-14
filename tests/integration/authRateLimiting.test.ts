import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { POST as registerPost } from "@/app/api/customers/register/route";
import { POST as adminLoginPost } from "@/app/api/admin/login/route";
import { authOptions } from "@/lib/auth/customer";
import { buildRateLimitKey } from "@/lib/rateLimit";

function withForwardedFor(ip: string, body: unknown, url: string) {
  const parsedUrl = new URL(url);
  return new NextRequest(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
      origin: parsedUrl.origin,
    },
    body: JSON.stringify(body),
  });
}

function uniqueIp(): string {
  const hex = crypto.randomUUID().replaceAll("-", "");
  return `2001:db8:${hex.slice(0, 4)}:${hex.slice(4, 8)}:${hex.slice(8, 12)}:${hex.slice(12, 16)}:${hex.slice(16, 20)}:${hex.slice(20, 24)}`;
}

describe("registration rate limiting", () => {
  it("limits repeated registration attempts for one email even across different IPs", async () => {
    const email = `ratelimit-register-${crypto.randomUUID()}@test.onlylive.ma`;

    for (let i = 0; i < 5; i += 1) {
      const response = await registerPost(
        withForwardedFor(
          uniqueIp(),
          {
            email,
            password: "RateLimitTestPassword123!",
            name: "Rate Limit Test",
          },
          "http://localhost/api/customers/register",
        ),
      );
      expect(response.status).toBe(i === 0 ? 201 : 409);
    }

    const sixth = await registerPost(
      withForwardedFor(
        uniqueIp(),
        { email, password: "RateLimitTestPassword123!", name: "X" },
        "http://localhost/api/customers/register",
      ),
    );
    expect(sixth.status).toBe(429);
    const body = await sixth.json();
    expect(body.error).toBe("RATE_LIMITED");
  });

  it("a different email is not affected by another email's exhausted account limit", async () => {
    const exhaustedEmail = `ratelimit-exhausted-${crypto.randomUUID()}@test.onlylive.ma`;
    for (let i = 0; i < 5; i += 1) {
      await registerPost(
        withForwardedFor(
          uniqueIp(),
          { email: exhaustedEmail, password: "RateLimitTestPassword123!", name: "X" },
          "http://localhost/api/customers/register",
        ),
      );
    }

    const response = await registerPost(
      withForwardedFor(
        uniqueIp(),
        { email: `ratelimit-fresh-${crypto.randomUUID()}@test.onlylive.ma`, password: "RateLimitTestPassword123!", name: "X" },
        "http://localhost/api/customers/register",
      ),
    );
    expect(response.status).toBe(201);
  });
});

describe("admin login rate limiting", () => {
  it("rejects one account across changing IPs before checking the credentials", async () => {
    const passwordHash = await hashPassword("AdminRateLimitTest123!");
    const admin = await prisma.adminUser.create({
      data: {
        email: `ratelimit-admin-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash,
        name: "Rate Limit Admin",
        role: "admin",
      },
    });
    for (let i = 0; i < 5; i += 1) {
      const response = await adminLoginPost(
        withForwardedFor(uniqueIp(), { email: admin.email, password: "wrong-password" }, "http://localhost/api/admin/login"),
      );
      expect(response.status).toBe(401);
    }

    const sixth = await adminLoginPost(
      // Even the CORRECT password is rejected once the failed-attempt limit
      // is already exhausted — the pre-check avoids another password hash.
      withForwardedFor(uniqueIp(), { email: admin.email, password: "AdminRateLimitTest123!" }, "http://localhost/api/admin/login"),
    );
    expect(sixth.status).toBe(429);
    expect(Number(sixth.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(sixth.headers.get("x-ratelimit-remaining")).toBe("0");
    const body = await sixth.json();
    expect(body.error).toBe("RATE_LIMITED");
  });

  it("does not consume the account failed-attempt budget on a successful login", async () => {
    const password = "AdminSuccessfulLogin123!";
    const admin = await prisma.adminUser.create({
      data: {
        email: `ratelimit-admin-success-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash: await hashPassword(password),
        name: "Successful Admin",
        role: "admin",
      },
    });

    const response = await adminLoginPost(
      withForwardedFor(uniqueIp(), { email: admin.email, password }, "http://localhost/api/admin/login"),
    );
    expect(response.status).toBe(200);

    const accountKey = buildRateLimitKey("admin_login_account", admin.email);
    expect(await prisma.rateLimitBucket.findFirst({ where: { key: accountKey } })).toBeNull();
  });
});

describe("customer login (authorize) rate limiting", () => {
  function customerAuthorize() {
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
    return rawProvider.options.authorize;
  }

  it("returns null for wrong credentials up to the limit, then throws RATE_LIMITED", async () => {
    const passwordHash = await hashPassword("CustomerRateLimitTest123!");
    const user = await prisma.user.create({
      data: {
        email: `ratelimit-customer-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash,
        name: "Rate Limit Customer",
      },
    });
    const authorize = customerAuthorize();
    for (let i = 0; i < 10; i += 1) {
      const req = { headers: { "x-forwarded-for": uniqueIp() } };
      const result = await authorize({ email: user.email, password: "wrong-password" }, req);
      expect(result).toBeNull();
    }

    await expect(async () => {
      const req = { headers: { "x-forwarded-for": uniqueIp() } };
      await authorize({ email: user.email, password: "CustomerRateLimitTest123!" }, req);
    }).rejects.toThrow("RATE_LIMITED");
  });

  it("does not consume the account failed-attempt budget on successful credentials", async () => {
    const password = "CustomerSuccessfulLogin123!";
    const user = await prisma.user.create({
      data: {
        email: `ratelimit-customer-success-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash: await hashPassword(password),
        name: "Successful Customer",
      },
    });
    const authorize = customerAuthorize();

    const result = await authorize(
      { email: user.email, password },
      { headers: { "x-forwarded-for": uniqueIp() } },
    );
    expect(result).toMatchObject({ id: user.id, email: user.email });

    const accountKey = buildRateLimitKey("customer_login_account", user.email);
    expect(await prisma.rateLimitBucket.findFirst({ where: { key: accountKey } })).toBeNull();
  });
});
