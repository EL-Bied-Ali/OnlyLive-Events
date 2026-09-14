import "dotenv/config";
import { spawnSync } from "node:child_process";
import { assertSafeE2eDatabase } from "./e2eDatabaseSafety";

function runNpx(args: string[], databaseUrl: string): void {
  const command = process.platform === "win32" ? "npx.cmd" : "npx";
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    shell: false,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`npx ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

const safeDatabase = assertSafeE2eDatabase({
  e2eDatabaseUrl: process.env.E2E_DATABASE_URL,
  developmentDatabaseUrl: process.env.DATABASE_URL,
  testDatabaseUrl: process.env.TEST_DATABASE_URL,
});

console.log(`Preparing isolated Playwright database: ${safeDatabase.databaseName}`);

// migrate reset is intentionally destructive. assertSafeE2eDatabase() makes
// it impossible to target the configured dev/Vitest DB and requires an
// explicit e2e database name. Seed explicitly afterwards because Prisma v7's
// seeding/reset documentation has changed over time; the seed itself is
// idempotent, so this is safe even if a CLI version also invokes it on reset.
runNpx(["prisma", "migrate", "reset", "--force"], safeDatabase.canonicalUrl);
runNpx(["tsx", "prisma/seed.ts"], safeDatabase.canonicalUrl);

console.log("Isolated Playwright database is ready.");
