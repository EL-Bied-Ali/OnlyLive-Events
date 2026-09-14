import { describe, expect, it } from "vitest";
import { assertSafeE2eDatabase } from "@/scripts/e2eDatabaseSafety";

const dev = "postgresql://onlylive:onlylive@localhost:5432/onlylive_dev";
const test = "postgresql://onlylive:onlylive@localhost:5432/onlylive_test";

describe("assertSafeE2eDatabase", () => {
  it("accepts separately named PostgreSQL e2e databases on loopback", () => {
    expect(
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@localhost:5432/onlylive_e2e",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: test,
      }),
    ).toMatchObject({ databaseName: "onlylive_e2e" });

    expect(
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@127.0.0.1:5432/onlylive_browser_e2e",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: test,
      }),
    ).toMatchObject({ databaseName: "onlylive_browser_e2e" });

    expect(
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@[::1]:5432/onlylive_ipv6_e2e",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: test,
      }),
    ).toMatchObject({ databaseName: "onlylive_ipv6_e2e" });
  });

  it("refuses a missing URL or a non-PostgreSQL URL", () => {
    expect(() => assertSafeE2eDatabase({ e2eDatabaseUrl: undefined })).toThrow("E2E_DATABASE_URL is required");
    expect(() => assertSafeE2eDatabase({ e2eDatabaseUrl: "mysql://localhost/onlylive_e2e" })).toThrow(
      "must use the postgresql:// or postgres:// protocol",
    );
  });

  it("refuses query parameters or fragments on the destructive E2E target", () => {
    for (const unsafe of [
      "postgresql://onlylive:onlylive@localhost:5432/onlylive_e2e?sslmode=require",
      "postgresql://onlylive:onlylive@localhost:5432/onlylive_e2e#unexpected",
    ]) {
      expect(() =>
        assertSafeE2eDatabase({
          e2eDatabaseUrl: unsafe,
          developmentDatabaseUrl: dev,
          testDatabaseUrl: test,
        }),
      ).toThrow("must not include query parameters or fragments");
    }
  });

  it("refuses any remote database even when its name looks like e2e", () => {
    expect(() =>
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:secret@db.example.com:5432/production_e2e",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: test,
      }),
    ).toThrow("must target localhost/loopback");
  });

  it("refuses a database name that is not explicitly marked e2e", () => {
    expect(() =>
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@localhost:5432/onlylive_dev_copy",
        developmentDatabaseUrl: dev,
      }),
    ).toThrow("must contain an explicit e2e segment");
  });

  it("refuses an E2E URL whose path contains more than one database-name segment", () => {
    expect(() =>
      assertSafeE2eDatabase({
        e2eDatabaseUrl: "postgresql://onlylive:onlylive@localhost:5432/onlylive_e2e/extra",
        developmentDatabaseUrl: dev,
        testDatabaseUrl: test,
      }),
    ).toThrow("must contain one explicit database name");
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
