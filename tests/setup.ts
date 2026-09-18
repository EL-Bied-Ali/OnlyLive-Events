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

// CI deliberately runs Postgres with a non-UTC TimeZone (see this repo's
// .github/workflows/ci.yml) specifically so this suite exercises the
// naive-timestamp-vs-now() class of bug documented in TASKS.md — every
// DateTime column here is a naive `timestamp`, and a raw-SQL `now()`
// compared against one is silently wrong by the server's UTC offset unless
// explicitly cast with `AT TIME ZONE 'UTC'`. If CI's Postgres ever silently
// reverts to UTC (image update, config drift), that protection disappears
// without anyone noticing — fail loudly instead of passing quietly. Local
// development is never affected: this only enforces when CI itself sets
// CI=true, never based on what timezone a contributor's own database happens
// to run.
if (process.env.CI === "true") {
  const { prisma } = await import("@/lib/db");
  const rows = await prisma.$queryRawUnsafe<{ tz: string }[]>(`SELECT current_setting('TimeZone') AS tz`);
  const tz = rows[0]?.tz;
  if (!tz || tz === "UTC" || tz === "Etc/UTC") {
    throw new Error(
      `CI Postgres TimeZone is "${tz}" — expected a deliberately non-UTC zone (see .github/workflows/ci.yml's ` +
        `postgres service TZ). This suite relies on a non-UTC session to catch naive-timestamp-vs-now() ` +
        `regressions; a UTC session would silently hide them again.`,
    );
  }
}
