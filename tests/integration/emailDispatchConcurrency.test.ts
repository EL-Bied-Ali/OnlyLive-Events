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
 *
 * This shared, non-isolated test database accumulates a large backlog of
 * pending rows across the whole suite (same pollution
 * dispatch-emails-route.test.ts already documents). This test must never
 * drain or otherwise mutate that global backlog itself -- doing so would
 * claim/send/retry/fail rows that belong to other, possibly concurrently
 * running, test files. Instead each seeded row's own `nextAttemptAt` is
 * pinned far enough in the past to sort first in the claim query's
 * `ORDER BY next_attempt_at ASC`, and every assertion is scoped to this
 * test's own two idempotency keys rather than the dispatch summaries'
 * global totals -- unrelated rows may legitimately be claimed alongside
 * them in the same batch, which is expected and not something to prevent.
 */
async function seedPendingConfirmationEmail() {
  const fixture = await createOrderAwaitingPayment();
  await prisma.$transaction(async (tx) => {
    const outcome = await confirmOrderPayment(fixture.order.id, tx);
    if (outcome !== "paid") throw new Error(`fixture setup did not reach paid, got ${outcome}`);
    await enqueueOrderConfirmationEmail(tx, fixture.order.id);
  });
  const row = await prisma.emailOutbox.findFirstOrThrow({
    where: { entityType: "order", entityId: fixture.order.id },
  });
  await prisma.emailOutbox.update({
    where: { id: row.id },
    data: { nextAttemptAt: new Date(0) },
  });
  return { ...fixture, outboxId: row.id };
}

describe("dispatchPendingEmails() concurrency", () => {
  it("never double-sends or drops a row when two dispatch calls race for the same backlog", async () => {
    const fixtureA = await seedPendingConfirmationEmail();
    const fixtureB = await seedPendingConfirmationEmail();
    const targetKeys = new Set([fixtureA.outboxId, fixtureB.outboxId]);
    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");

    await Promise.all([
      dispatchPendingEmails(),
      dispatchPendingEmails(),
    ]);

    // Directly proves the provider was invoked exactly once for each of
    // this test's own two rows specifically -- filtered by idempotency key
    // so unrelated rows legitimately claimed in the same batch (this is a
    // shared, non-isolated backlog) can never mask a real double-send.
    const targetCalls = sendSpy.mock.calls.filter(([input]) => targetKeys.has(input.idempotencyKey));
    expect(targetCalls).toHaveLength(2);
    const calledKeys = targetCalls.map(([input]) => input.idempotencyKey);
    expect(new Set(calledKeys).size).toBe(2);

    const rows = await prisma.emailOutbox.findMany({
      where: { id: { in: [fixtureA.outboxId, fixtureB.outboxId] } },
    });
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBe("sent");
      expect(row.sentAt).not.toBeNull();
    }
    // Generous, not a correctness workaround: this test never inflates the
    // shared backlog itself (see the comment above), but a full batch each
    // concurrent call claims can legitimately include other, unrelated
    // pending rows from test files running in other parallel workers, and
    // processing all of them still has to happen inside this one call.
  }, 20_000);
});
