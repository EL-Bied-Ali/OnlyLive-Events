export interface SafeE2eDatabase {
  canonicalUrl: string;
  databaseName: string;
}

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

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1" || normalized === "[::1]";
}

export function assertSafeE2eDatabase(input: {
  e2eDatabaseUrl: string | undefined;
  developmentDatabaseUrl?: string;
  testDatabaseUrl?: string;
}): SafeE2eDatabase {
  const e2e = parseDatabaseUrl("E2E_DATABASE_URL", input.e2eDatabaseUrl);
  const e2eCanonical = canonical(e2e);
  const e2eName = databaseName(e2e);

  if (!e2eName) {
    throw new Error("Refusing destructive e2e reset: E2E_DATABASE_URL must name a database.");
  }

  if (!isLoopbackHost(e2e.hostname)) {
    throw new Error(
      `Refusing destructive e2e reset: E2E_DATABASE_URL must target localhost/loopback, not "${e2e.hostname}".`,
    );
  }

  if (!/(^|[_-])e2e($|[_-])/i.test(e2eName)) {
    throw new Error(
      `Refusing destructive e2e reset: database name "${e2eName}" must contain an explicit e2e segment (for example onlylive_e2e).`,
    );
  }

  for (const [name, raw] of [
    ["DATABASE_URL", input.developmentDatabaseUrl],
    ["TEST_DATABASE_URL", input.testDatabaseUrl],
  ] as const) {
    if (!raw) continue;
    const other = parseDatabaseUrl(name, raw);
    if (canonical(other) === e2eCanonical || databaseName(other) === e2eName) {
      throw new Error(`Refusing destructive e2e reset: E2E_DATABASE_URL must be distinct from ${name}.`);
    }
  }

  return { canonicalUrl: e2eCanonical, databaseName: e2eName };
}
