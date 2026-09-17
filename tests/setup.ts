import "dotenv/config";

// Route all Prisma access in the test process at the dedicated test
// database, never the dev database — this must run before any test file
// imports lib/db.
if (process.env.TEST_DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
} else {
  throw new Error("TEST_DATABASE_URL is not set — refusing to run tests against DATABASE_URL");
}

// The shared, non-isolated test database accumulates a large backlog of
// pending email_outbox rows across the whole suite (any test that drives a
// payment webhook enqueues one, even tests unrelated to email). Use a large
// batch size so a dispatcher test's own row is never crowded out of a batch
// by that backlog — see lib/email/dispatcher.ts.
process.env.EMAIL_DISPATCH_BATCH_SIZE = "5000";
