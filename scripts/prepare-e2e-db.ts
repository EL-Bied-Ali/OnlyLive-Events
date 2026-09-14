import "dotenv/config";
import { spawnSync } from "node:child_process";

function parseDatabaseUrl(name: string, raw: string | undefined): URL {
  if (!raw) {
    throw new Error(`${name} is required. Configure a dedicated Playwright database before running e2e tests.`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }

  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") {
    throw new Error(`${name} must use the postgresql:// or postgres:// protocol.`);
  }
  return url;
}

function canonical(url: URL): string {
  const copy = new URL(url.toString());
  copy.hash = "";
  return copy.toString();
}

function databaseName(url: URL): string {
  return decodeURIComponent(url.pathname.replace(/^\//, ""));
}

function run(command: string, args: string[], databaseUrl: string): void {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}`);
  }
}

const e2e = parseDatabaseUrl("E2E_DATABASE_URL", process.env.E2E_DATABASE_URL);
const e2eCanonical = canonical(e2e);
const e2eName = databaseName(e2e);

if (!/(^|[_-])e2e($|[_-])/i.test(e2eName)) {
  throw new Error(
    `Refusing destructive e2e reset: database name "${e2eName}" must contain an explicit e2e segment (for example onlylive_e2e).`,
  );
}

for (const [name, raw] of [
  ["DATABASE_URL", process.env.DATABASE_URL],
  ["TEST_DATABASE_URL", process.env.TEST_DATABASE_URL],
] as const) {
  if (!raw) continue;
  const other = parseDatabaseUrl(name, raw);
  if (canonical(other) === e2eCanonical || databaseName(other) === e2eName) {
    throw new Error(`Refusing destructive e2e reset: E2E_DATABASE_URL must be distinct from ${name}.`);
  }
}

console.log(`Preparing isolated Playwright database: ${e2eName}`);

// migrate reset is intentionally destructive. The guards above ensure it can
// only target a separately named e2e database, never the dev/Vitest database.
// Prisma v7 seeding behavior changed across releases/docs, so seed explicitly
// afterwards instead of relying on reset to invoke it implicitly.
run("npx", ["prisma", "migrate", "reset", "--force"], e2eCanonical);
run("npx", ["tsx", "prisma/seed.ts"], e2eCanonical);

console.log("Isolated Playwright database is ready.");
