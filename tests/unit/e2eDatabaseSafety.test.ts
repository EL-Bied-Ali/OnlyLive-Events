import { describe, expect, it } from "vitest";
import { assertSafeE2eDatabase } from "@/scripts/e2eDatabaseSafety";

const dev = "postgresql://onlylive:onlylive@localhost:5432/onlylive_dev";
const test = "postgresql://onlylive:onlylive@localhost:5432/onlylive_test";

describe("assertSafeE2eDatabase", () => {
  it("accepts a separately named PostgreSQL e2e database", () => {
    expect(
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@localhost:5432/onlylive_e2e",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: test,
      }),
    ).toMatchObject({ databaseName: "onlylive_e2e" });
  });

  it("refuses a missing URL or a non-PostgreSQL URL", () => {
    expect(() => assertSafeE2eDatabase({ e2eDatabaseUrl: undefined })).toThrow("E2E_DATABASE_URL is required");
    expect(() => assertSafeE2eDatabase({ e2eDatabaseUrl: "mysql://localhost/onlylive_e2e" })).toThrow(
      "must use the postgresql:// or postgres:// protocol",
    );
  });

  it("refuses a database name that is not explicitly marked e2e", () => {
    expect(() =>
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@localhost:5432/onlylive_dev_copy",
        developmentDatabaseUrl: dev,
      }),
    ).toThrow("must contain an explicit e2e segment");
  });

  it("refuses the configured development database even if its name contains e2e", () => {
    const unsafe = "postgresql://onlylive:onlylive@localhost:5432/onlylive_e2e";
    expect(() =>
      assertSafeE2eDatabase({
        e2eDatabaseUrl: unsafe,
        developmentDatabaseUrl: unsafe,
        testDatabaseUrl: test,
      }),
    ).toThrow("must be distinct from DATABASE_URL");
  });

  it("refuses the configured Vitest database even when connection strings differ but the DB name matches", () => {
    expect(() =>
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://e2e-user:e2e-pass@127.0.0.1:5432/onlylive_e2e",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: "postgresql://other:other@localhost:5432/onlylive_e2e",
      }),
    ).toThrow("must be distinct from TEST_DATABASE_URL");
  });
});
