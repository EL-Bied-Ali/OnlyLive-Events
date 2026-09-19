import "dotenv/config";
import { defineConfig } from "prisma/config";
import { hardenPostgresSslMode } from "./lib/postgresConnection";

export default defineConfig({
  schema: "prisma/schema.prisma",
  datasource: {
    // Deliberately NOT using @prisma/config's `env()` helper here — it
    // throws immediately if DATABASE_URL is unset, which broke `prisma
    // generate` (client generation needs the schema only, no live DB
    // connection) in any environment without a database configured yet,
    // e.g. `npm ci` in CI/build before secrets are provisioned. A plain
    // `process.env.DATABASE_URL` read leaves it undefined in that case;
    // `prisma generate` doesn't need it, and `migrate`/`db push` will
    // still fail with Prisma's own clear error if it's genuinely absent
    // when one of those commands actually needs a connection.
    url: process.env.DATABASE_URL
      ? hardenPostgresSslMode(process.env.DATABASE_URL)
      : undefined,
  },
  migrations: {
    seed: "tsx prisma/seed.ts",
  },
});
