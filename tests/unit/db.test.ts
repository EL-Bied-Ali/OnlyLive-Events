import { describe, expect, it, vi, afterEach } from "vitest";

describe("lib/db lazy Prisma client", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
  });

  it("imports without throwing even when DATABASE_URL is unset", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    await expect(import("@/lib/db")).resolves.toBeDefined();
  });

  it("only throws once an operation is actually attempted without DATABASE_URL", async () => {
    delete process.env.DATABASE_URL;
    vi.resetModules();
    const { prisma } = await import("@/lib/db");
    expect(() => prisma.$connect()).toThrow("DATABASE_URL is not set");
  });

  it("works normally once DATABASE_URL is present", async () => {
    process.env.DATABASE_URL = originalDatabaseUrl;
    vi.resetModules();
    const { prisma } = await import("@/lib/db");
    await expect(prisma.$queryRaw`SELECT 1 as one`).resolves.toEqual([{ one: 1 }]);
  });
});
