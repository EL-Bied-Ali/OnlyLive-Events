import { describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { confirmOrderPayment } from "@/lib/orders/fulfillment";
import { enqueueOrderConfirmationEmail } from "@/lib/email/notifications";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";
import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
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

/**
 * This shared, non-isolated test database accumulates a large backlog of
 * pending rows across the whole suite (same pollution
 * dispatch-emails-route.test.ts already documents). Draining it first makes
 * this test's own two rows the entire backlog, so the race it exercises is
 * never masked or defeated by however many unrelated rows happen to be
 * sitting there when it runs. Capped so a pathological/unbounded backlog
 * cannot spin this into an effectively infinite loop.
 */
async function drainBacklog() {
  for (let i = 0; i < 50; i += 1) {
    const summary = await dispatchPendingEmails();
    if (summary.claimed === 0) return;
  }
  throw new Error("drainBacklog: backlog did not empty after 50 dispatch passes");
}

describe("dispatchPendingEmails() concurrency", () => {
  it("never double-sends or drops a row when two dispatch calls race for the same backlog", async () => {
    await drainBacklog();

    const fixtureA = await seedPendingConfirmationEmail();
    const fixtureB = await seedPendingConfirmationEmail();
    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");

    const [summaryA, summaryB] = await Promise.all([
      dispatchPendingEmails(),
      dispatchPendingEmails(),
    ]);

    // FOR UPDATE SKIP LOCKED guarantees the two calls partition the backlog
    // rather than both claiming the same row. With the backlog drained
    // first, these two rows are the entire backlog, so the totals must be
    // exactly 2, not just "at least 2".
    expect(summaryA.claimed + summaryB.claimed).toBe(2);
    expect(summaryA.sent + summaryB.sent).toBe(2);

    const rows = await prisma.emailOutbox.findMany({
      where: { entityType: "order", entityId: { in: [fixtureA.order.id, fixtureB.order.id] } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.sentAt).not.toBeNull();
    }

    // Directly proves the provider was invoked exactly once per row, not
    // just that the DB's own status column says "sent" once each — a
    // defense-in-depth check that a race couldn't have triggered two
    // provider sends for the same row even if something else about the
    // claim's atomicity were ever weakened.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const idempotencyKeys = sendSpy.mock.calls.map(([input]) => input.idempotencyKey);
    expect(new Set(idempotencyKeys).size).toBe(2);
  }, 30_000);
});
