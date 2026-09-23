import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

declare global {
  var __prisma: PrismaClient | undefined;
}

export function normalizeDatabaseConnectionString(connectionString: string): string {
  // pg 8.x currently treats prefer/require/verify-ca as verify-full, but
  // pg 9 will switch those names to libpq's weaker semantics. Make the
  // security level we rely on explicit now so an eventual dependency
  // upgrade cannot silently weaken certificate verification.
  return connectionString.replace(
    /([?&]sslmode=)(prefer|require|verify-ca)(?=(&|$))/gi,
    "$1verify-full",
  );
}

function createPrismaClient(): PrismaClient {
  const configuredConnectionString = process.env.DATABASE_URL;
  if (!configuredConnectionString) {
    throw new Error("DATABASE_URL is not set");
  }
  const connectionString = normalizeDatabaseConnectionString(configuredConnectionString);
  const adapter = new PrismaPg({ connectionString });
  return new PrismaClient({ adapter });
}

let instance: PrismaClient | undefined;

// Lazy: constructing the client (and requiring DATABASE_URL) is deferred to
// first actual use, not module import. Next.js's build-time "collect page
// data" step imports every route module — including ones that never touch
// the database, like /api/admin/logout — so an eager `new PrismaClient()`
// at the top of this module fails the build in any environment without
// DATABASE_URL configured, regardless of whether that route needs it.
function getPrismaClient(): PrismaClient {
  if (globalThis.__prisma) return globalThis.__prisma;
  if (instance) return instance;
  instance = createPrismaClient();
  if (process.env.NODE_ENV !== "production") {
    globalThis.__prisma = instance;
  }
  return instance;
}

export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(getPrismaClient(), prop, receiver);
  },
});
