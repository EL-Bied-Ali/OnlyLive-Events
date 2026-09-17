import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import { POST as webhookPost } from "@/app/api/payments/webhook/fake/route";
import { initiateRefund } from "@/lib/orders/refund";
import { enqueueOrderConfirmationEmail, enqueuePaymentFailedEmail, enqueueRefundConfirmationEmail } from "@/lib/email/notifications";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function buildWebhookRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  return new NextRequest("http://localhost/api/payments/webhook/fake", {
    method: "POST",
    headers: { "content-type": "application/json", "x-onlylive-fake-signature": signFakeWebhookPayload(body) },
    body,
  });
}

async function postWebhook(fixture: Awaited<ReturnType<typeof createOrderAwaitingPayment>>, type: "payment.succeeded" | "payment.failed") {
  const payload = {
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type,
    amountCents: fixture.payment.amountCents,
    currency: fixture.payment.currency,
  };
  return webhookPost(buildWebhookRequest(payload));
}

describe("email outbox — enqueue idempotency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("enqueues exactly one order_confirmation row per order, even called twice in the same transaction pattern", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "paid" } });
    await prisma.$transaction((tx) => enqueueOrderConfirmationEmail(tx, fixture.order.id));
    await prisma.$transaction((tx) => enqueueOrderConfirmationEmail(tx, fixture.order.id));

    const rows = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.recipientEmail).toBe(fixture.user.email);
    expect(rows[0]!.status).toBe("pending");
  });

  it("enqueues exactly one payment_failed row per order, even called twice", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await prisma.$transaction((tx) => enqueuePaymentFailedEmail(tx, fixture.order.id));
    await prisma.$transaction((tx) => enqueuePaymentFailedEmail(tx, fixture.order.id));

    const rows = await prisma.emailOutbox.findMany({
      where: { type: "payment_failed", entityType: "order", entityId: fixture.order.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("failed-payment messaging never promises that no debit occurred", async () => {
    // This wording guarantee predates the durable outbox (it was originally
    // checked against the old immediate-send path) — ported here against
    // the current enqueue/dispatch architecture so the regression coverage
    // isn't lost. Content now comes from lib/email/dispatcher.ts's
    // renderPaymentFailed(), not from the enqueue call itself.
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "failed" } });
    await prisma.$transaction((tx) => enqueuePaymentFailedEmail(tx, fixture.order.id));

    const send = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();

    const call = send.mock.calls.find((args) => args[0].to === fixture.user.email);
    expect(call).toBeDefined();
    const message = call![0];
    expect(message.subject).toContain(fixture.order.orderNumber);
    expect(message.text).toContain("ne payez pas une seconde fois");
    expect(message.text).not.toContain("Aucun montant n'a été débité");
  });

  it("is a silent no-op for an unknown order/refund id rather than throwing", async () => {
    const unknownId = crypto.randomUUID();
    await expect(prisma.$transaction((tx) => enqueueOrderConfirmationEmail(tx, unknownId))).resolves.toBeUndefined();
    await expect(prisma.$transaction((tx) => enqueuePaymentFailedEmail(tx, unknownId))).resolves.toBeUndefined();
    await expect(prisma.$transaction((tx) => enqueueRefundConfirmationEmail(tx, unknownId))).resolves.toBeUndefined();

    const rows = await prisma.emailOutbox.findMany({ where: { entityId: unknownId } });
    expect(rows).toHaveLength(0);
  });

  it("the payment webhook enqueues an order_confirmation row exactly once, even under a duplicate delivery", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 2 });
    const response1 = await postWebhook(fixture, "payment.succeeded");
    expect(response1.status).toBe(200);

    // A genuinely duplicate delivery (new event id, same underlying
    // payment already settled) must not enqueue a second row.
    const response2 = await postWebhook(fixture, "payment.succeeded");
    expect(response2.status).toBe(200);

    const rows = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("pending");
  });

  it("the payment webhook enqueues a payment_failed row when the payment fails", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const response = await postWebhook(fixture, "payment.failed");
    expect(response.status).toBe(200);

    const rows = await prisma.emailOutbox.findMany({
      where: { type: "payment_failed", entityType: "order", entityId: fixture.order.id },
    });
    expect(rows).toHaveLength(1);
  });

  it("a succeeded refund enqueues exactly one refund_confirmation row", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 10_000 });
    await postWebhook(fixture, "payment.succeeded");

    const admin = await prisma.adminUser.create({
      data: {
        email: `notif-admin-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash: "not-used-in-tests",
        name: "Notif Admin",
        role: "admin",
      },
    });
    const result = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: "Internal note: customer called twice, approved by manager",
      actorId: admin.id,
    });

    const rows = await prisma.emailOutbox.findMany({
      where: { type: "refund_confirmation", entityType: "refund", entityId: result.refundId },
    });
    expect(rows).toHaveLength(1);
  });
});

describe("email dispatcher — send, retry, and business-state re-validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dispatches a pending order_confirmation row, marking it sent with a provider message id", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");

    const summary = await dispatchPendingEmails();
    expect(summary.sent).toBeGreaterThanOrEqual(1);

    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(row.status).toBe("sent");
    expect(row.sentAt).not.toBeNull();
    expect(row.providerMessageId).toBeTruthy();
  });

  it("passes the outbox row's own id as the provider idempotencyKey", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");
    const before = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });

    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();

    expect(sendSpy).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: before.id }));
  });

  it("re-validates business state at dispatch time: a row whose order left the expected status is never sent", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");

    // Simulate the order having moved away from "paid" by the time the
    // dispatcher gets to this row (e.g. a full refund already processed
    // it) — the enqueued content assumption no longer holds.
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "refunded" } });

    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();

    // Scoped to this fixture's own recipient: the shared test database can
    // have other, unrelated rows legitimately due in the same batch.
    expect(sendSpy.mock.calls.some((args) => args[0].to === fixture.user.email)).toBe(false);
    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(row.status).toBe("failed");
    expect(row.lastErrorCode).toBe("entity_state_no_longer_valid");
  });

  it("still sends the order confirmation after a partial refund, since valid tickets survive it", async () => {
    // A partial refund moves the order to "partially_refunded" but only a
    // *full* refund cancels tickets (lib/orders/refund.ts) — the queued
    // order confirmation (and its ticket links) is still correct content
    // and must not be discarded as stale.
    const fixture = await createOrderAwaitingPayment({ quantity: 2, priceCents: 10_000 });
    await postWebhook(fixture, "payment.succeeded");

    const admin = await prisma.adminUser.create({
      data: {
        email: `notif-partial-refund-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash: "not-used-in-tests",
        name: "Notif Admin",
        role: "admin",
      },
    });
    const refundResult = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000, // half of the 20,000-cent total: a genuine partial refund
      reason: "Customer no-show for one ticket",
      actorId: admin.id,
    });
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("partially_refunded");

    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();

    const ownCalls = sendSpy.mock.calls.filter((args) => args[0].to === fixture.user.email);
    expect(ownCalls).toHaveLength(2); // order_confirmation + refund_confirmation, each exactly once

    const confirmationRow = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(confirmationRow.status).toBe("sent");

    const refundRow = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "refund_confirmation", entityType: "refund", entityId: refundResult.refundId },
    });
    expect(refundRow.status).toBe("sent");
  });

  it("never includes the admin-entered refund reason in the rendered customer-facing text", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 10_000 });
    await postWebhook(fixture, "payment.succeeded");
    const admin = await prisma.adminUser.create({
      data: {
        email: `notif-admin-reason-${crypto.randomUUID()}@test.onlylive.ma`,
        passwordHash: "not-used-in-tests",
        name: "Notif Admin",
        role: "admin",
      },
    });
    const secretInternalNote = "INTERNAL-ONLY-NOTE-should-never-reach-customer";
    await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: 10_000,
      reason: secretInternalNote,
      actorId: admin.id,
    });

    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();

    const call = sendSpy.mock.calls.find((args) => args[0].to === fixture.user.email);
    expect(call).toBeTruthy();
    expect(call![0].text).not.toContain(secretInternalNote);
  });

  it("retries a transient provider failure with a backed-off nextAttemptAt, without marking it permanently failed", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");
    // Reject only this fixture's own send — the shared test database can
    // have other rows due in the same batch, and a blind
    // mockRejectedValueOnce would land on whichever row happens to be
    // rendered first, not necessarily this test's own row.
    const originalSend = ConsoleEmailProvider.prototype.send;
    vi.spyOn(ConsoleEmailProvider.prototype, "send").mockImplementation(function (this: ConsoleEmailProvider, input) {
      if (input.to === fixture.user.email) {
        return Promise.reject(new Error("simulated transient outage"));
      }
      return originalSend.call(this, input);
    });

    const before = Date.now();
    const summary = await dispatchPendingEmails();
    expect(summary.retried).toBeGreaterThanOrEqual(1);

    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(row.status).toBe("pending");
    expect(row.attemptCount).toBe(1);
    expect(row.lastErrorCode).toContain("simulated transient outage");
    expect(row.nextAttemptAt.getTime()).toBeGreaterThan(before);

    // Not immediately reclaimed: nextAttemptAt is in the future. Scoped to
    // this fixture's own recipient — the shared test database can have
    // other, unrelated rows legitimately due in the same batch.
    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    sendSpy.mockClear();
    await dispatchPendingEmails();
    expect(sendSpy.mock.calls.some((args) => args[0].to === fixture.user.email)).toBe(false);
  });

  it("a rendering exception for one row is retried on its own and never blocks another row in the same batch", async () => {
    const throwingFixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(throwingFixture, "payment.succeeded");
    const healthyFixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(healthyFixture, "payment.succeeded");

    // Fail only this fixture's own render — a blind mockImplementationOnce
    // would land on whichever row the batch happens to render first, not
    // necessarily this test's own row (see the identical note on the
    // provider-failure tests above).
    const originalFindUnique = prisma.order.findUnique.bind(prisma.order);
    vi.spyOn(prisma.order, "findUnique").mockImplementation((args: Parameters<typeof prisma.order.findUnique>[0]) => {
      if (args?.where?.id === throwingFixture.order.id) {
        throw new Error("simulated transient render failure");
      }
      return originalFindUnique(args);
    });

    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();

    // The healthy row in the same batch still got sent — one row's render
    // exception never aborted the whole dispatchPendingEmails() call.
    expect(sendSpy.mock.calls.some((args) => args[0].to === healthyFixture.user.email)).toBe(true);

    const throwingRow = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: throwingFixture.order.id },
    });
    // Retried like a send failure, not silently discarded as stale content
    // and not stuck in "processing" for the full lease window.
    expect(throwingRow.status).toBe("pending");
    expect(throwingRow.attemptCount).toBe(1);
    expect(throwingRow.lastErrorCode).toContain("simulated transient render failure");
  });

  it("never logs the raw recipient address or full error object on a send failure", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");
    // Reject only this fixture's own send — see the identical note in the
    // "retries a transient provider failure" test above.
    const originalSend = ConsoleEmailProvider.prototype.send;
    vi.spyOn(ConsoleEmailProvider.prototype, "send").mockImplementation(function (this: ConsoleEmailProvider, input) {
      if (input.to === fixture.user.email) {
        return Promise.reject(new Error("simulated transient outage"));
      }
      return originalSend.call(this, input);
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await dispatchPendingEmails();

    const loggedText = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
    expect(loggedText).not.toContain(fixture.user.email);
    expect(loggedText).toContain("recipientHash=");
  });

  it("permanently fails a row once it exhausts its retry budget, and stops attempting it", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");
    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    // Fast-forward straight to one attempt below the retry budget so this
    // test doesn't need eight real dispatch/backoff round trips.
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { attemptCount: 7, nextAttemptAt: new Date(Date.now() - 1000) },
    });
    // Reject only this fixture's own send — see the identical note above.
    const originalSend = ConsoleEmailProvider.prototype.send;
    vi.spyOn(ConsoleEmailProvider.prototype, "send").mockImplementation(function (this: ConsoleEmailProvider, input) {
      if (input.to === fixture.user.email) {
        return Promise.reject(new Error("permanent-looking failure"));
      }
      return originalSend.call(this, input);
    });

    const summary = await dispatchPendingEmails();
    expect(summary.permanentlyFailed).toBeGreaterThanOrEqual(1);

    const updated = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("failed");
    expect(updated.attemptCount).toBe(8);

    // A failed row is never picked up again, even once "due". Scoped to
    // this fixture's own recipient — see the identical note above.
    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    sendSpy.mockClear();
    await dispatchPendingEmails();
    expect(sendSpy.mock.calls.some((args) => args[0].to === fixture.user.email)).toBe(false);
  });

  it("reclaims a row whose lease expired (a crashed worker never finished it), instead of leaving it stuck forever", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");
    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    // Simulate a worker that claimed this row and then crashed before
    // finishing: status="processing" with a processingStartedAt far in
    // the past, well beyond the dispatcher's lease timeout.
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { status: "processing", processingStartedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    const summary = await dispatchPendingEmails();
    expect(summary.sent).toBeGreaterThanOrEqual(1);

    const updated = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(updated.status).toBe("sent");
  });

  it("does not reclaim a row still within its lease window", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");
    const row = await prisma.emailOutbox.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    await prisma.emailOutbox.update({
      where: { id: row.id },
      data: { status: "processing", processingStartedAt: new Date() },
    });

    // Scoped to this fixture's own recipient — the shared test database can
    // have other, unrelated rows legitimately due in the same batch.
    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await dispatchPendingEmails();
    expect(sendSpy.mock.calls.some((args) => args[0].to === fixture.user.email)).toBe(false);

    const unchanged = await prisma.emailOutbox.findUniqueOrThrow({ where: { id: row.id } });
    expect(unchanged.status).toBe("processing");
  });

  it("two concurrent dispatch calls never send the same row twice (atomic claim)", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await postWebhook(fixture, "payment.succeeded");

    const sendSpy = vi.spyOn(ConsoleEmailProvider.prototype, "send");
    await Promise.all([dispatchPendingEmails(), dispatchPendingEmails()]);

    const calls = sendSpy.mock.calls.filter((args) => args[0].to === fixture.user.email);
    expect(calls).toHaveLength(1);
  });

  it("is a no-op when there is nothing due", async () => {
    // The shared test database is never guaranteed empty (other test files
    // enqueue rows they don't dispatch themselves) — drain whatever backlog
    // exists first, then verify a call against a genuinely empty queue.
    for (let drained = await dispatchPendingEmails(); drained.claimed > 0; drained = await dispatchPendingEmails()) {
      // keep draining
    }
    const summary = await dispatchPendingEmails();
    expect(summary).toMatchObject({ claimed: 0, sent: 0, retried: 0, permanentlyFailed: 0, skipped: 0 });
  });
});
