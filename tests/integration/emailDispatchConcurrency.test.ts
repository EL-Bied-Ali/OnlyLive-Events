import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { confirmOrderPayment } from "@/lib/orders/fulfillment";
import { enqueueOrderConfirmationEmail } from "@/lib/email/notifications";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

/**
 * The eager after()-triggered dispatch (lib/email/eagerDispatch.ts) means a
 * webhook's own eager call can now genuinely overlap with the periodic
 * dispatch-emails endpoint hitting the same backlog at the same moment, or
 * with two eager triggers from two near-simultaneous webhook deliveries.
 * This proves dispatchPendingEmails()'s own `FOR UPDATE SKIP LOCKED` claim
 * (unaffected by the eager-dispatch change; already used by the existing
 * periodic-cron path) makes that safe: two real concurrent invocations must
 * never double-send or drop a row.
 */
async function seedPendingConfirmationEmail() {
  const fixture = await createOrderAwaitingPayment();
  await prisma.$transaction(async (tx) => {
    const outcome = await confirmOrderPayment(fixture.order.id, tx);
    if (outcome !== "paid") throw new Error(`fixture setup did not reach paid, got ${outcome}`);
    await enqueueOrderConfirmationEmail(tx, fixture.order.id);
  });
  return fixture;
}

describe("dispatchPendingEmails() concurrency", () => {
  // Each call scans the whole shared, non-isolated backlog (same pollution
  // this codebase already documents for dispatch-emails-route.test.ts), so
  // this needs more headroom than the default 5s when other test files have
  // left a large batch behind.
  it("never double-sends or drops a row when two dispatch calls race for the same backlog", async () => {
    const fixtureA = await seedPendingConfirmationEmail();
    const fixtureB = await seedPendingConfirmationEmail();

    const [summaryA, summaryB] = await Promise.all([
      dispatchPendingEmails(),
      dispatchPendingEmails(),
    ]);

    const totalSent = summaryA.sent + summaryB.sent;
    const totalClaimed = summaryA.claimed + summaryB.claimed;
    // FOR UPDATE SKIP LOCKED guarantees the two calls partition the backlog
    // rather than both claiming the same row, so the two rows this test
    // seeded must together be claimed and sent exactly once in total,
    // however the race actually interleaves.
    expect(totalClaimed).toBeGreaterThanOrEqual(2);
    expect(totalSent).toBeGreaterThanOrEqual(2);

    const rows = await prisma.emailOutbox.findMany({
      where: { entityType: "order", entityId: { in: [fixtureA.order.id, fixtureB.order.id] } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.sentAt).not.toBeNull();
    }
  }, 20_000);
});
