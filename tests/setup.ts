import "dotenv/config";

// Route all Prisma access in the test process at the dedicated test
// database, never the dev database — this must run before any test file
// imports lib/db.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  throw new Error("TEST_DATABASE_URL is not set — refusing to run tests against DATABASE_URL");
}
