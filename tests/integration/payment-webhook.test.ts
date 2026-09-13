import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { POST as webhookPost } from "@/app/api/payments/webhook/fake/route";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function buildWebhookRequest(payload: unknown, signature: string | null) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signature !== null) {
    headers["x-onlylive-fake-signature"] = signature;
  }
  return new NextRequest("http://localhost/api/payments/webhook/fake", {
    method: "POST",
    headers,
    body,
  });
}

function makePayload(
  fixture: Awaited<ReturnType<typeof createOrderAwaitingPayment>>,
  type: "payment.succeeded" | "payment.failed" | "payment.cancelled",
  overrides: Partial<{ amountCents: number; currency: string }> = {},
) {
  return {
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type,
    amountCents: overrides.amountCents ?? fixture.payment.amountCents,
    currency: overrides.currency ?? fixture.payment.currency,
  };
}

async function post(payload: object, badSignature?: string) {
  const signature = badSignature ?? signFakeWebhookPayload(JSON.stringify(payload));
  return webhookPost(buildWebhookRequest(payload, signature));
}

describe("payment webhook — verification, idempotency, and fulfillment", () => {
  it("confirms payment and generates exactly one ticket per unit for a qty=3 order", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 3 });
    const response = await post(makePayload(fixture, "payment.succeeded"));
    expect(response.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(3);
    expect(new Set(tickets.map((t) => t.validationToken)).size).toBe(3);
  });

  it("is idempotent under an exact duplicate webhook delivery (same event id)", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = makePayload(fixture, "payment.succeeded");
    const signature = signFakeWebhookPayload(JSON.stringify(payload));

    const first = await webhookPost(buildWebhookRequest(payload, signature));
    const second = await webhookPost(buildWebhookRequest(payload, signature));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toMatchObject({ duplicate: true });

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("does not double-generate tickets even from two different event ids for the same payment", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await post(makePayload(fixture, "payment.succeeded"));
    await post(makePayload(fixture, "payment.succeeded"));

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("reprocesses a payment_events row that was claimed but never marked processed (simulated interruption)", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = makePayload(fixture, "payment.succeeded");

    // Simulate a prior attempt that claimed the event but crashed before
    // finishing — a payment_events row exists with processedAt still
    // null. Before this session's atomicity fix, a retry of the exact
    // same event would have hit ON CONFLICT and been silently
    // acknowledged as "duplicate" without ever generating tickets.
    await prisma.$executeRaw`
      INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES (${crypto.randomUUID()}, ${fixture.payment.id}, 'fake', ${payload.eventId}, ${payload.type}, ${JSON.stringify(payload)}::jsonb, true, now())
    `;

    const response = await post(payload);
    expect(response.status).toBe(200);
    expect(await response.json()).not.toMatchObject({ duplicate: true });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("never reprocesses a previously invalid-signature event id as valid, even with a correct signature now", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = makePayload(fixture, "payment.succeeded");

    // Simulate a prior forged attempt under this exact event id: claimed,
    // signature invalid, never processed (by design — see the route).
    await prisma.$executeRaw`
      INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES (${crypto.randomUUID()}, ${fixture.payment.id}, 'fake', ${payload.eventId}, ${payload.type}, ${JSON.stringify(payload)}::jsonb, false, now())
    `;

    // Now resend the SAME event id, this time correctly signed. It must
    // still be rejected as a collision, not silently processed.
    const response = await post(payload);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "EVENT_COLLISION" });

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("pending_payment");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);

    // The original row's misleading fields are never overwritten by the
    // new, differently-signed attempt.
    const stored = await prisma.paymentEvent.findUniqueOrThrow({
      where: { provider_externalEventId: { provider: "fake", externalEventId: payload.eventId } },
    });
    expect(stored.signatureValid).toBe(false);
    expect(stored.processedAt).toBeNull();

    const auditEntries = await prisma.auditLog.findMany({
      where: { action: "payment.webhook_event_collision" },
    });
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  it("rejects a reclaim attempt whose resolved payment differs from the originally claimed payment", async () => {
    const fixtureA = await createOrderAwaitingPayment({ quantity: 1 });
    const fixtureB = await createOrderAwaitingPayment({ quantity: 1 });

    const sharedEventId = crypto.randomUUID();
    // Simulate an interrupted claim originally made under Payment A.
    await prisma.$executeRaw`
      INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES (${crypto.randomUUID()}, ${fixtureA.payment.id}, 'fake', ${sharedEventId}, 'payment.succeeded', '{}'::jsonb, true, now())
    `;

    // A webhook now arrives whose providerPaymentId resolves to Payment
    // B, but reuses that same external event id.
    const collidingPayload = {
      eventId: sharedEventId,
      providerPaymentId: fixtureB.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixtureB.payment.amountCents,
      currency: fixtureB.payment.currency,
    };
    const response = await post(collidingPayload);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "EVENT_COLLISION" });

    const orderA = await prisma.order.findUniqueOrThrow({ where: { id: fixtureA.order.id } });
    const orderB = await prisma.order.findUniqueOrThrow({ where: { id: fixtureB.order.id } });
    expect(orderA.status).toBe("pending_payment");
    expect(orderB.status).toBe("pending_payment");

    const auditEntries = await prisma.auditLog.findMany({ where: { action: "payment.webhook_event_collision" } });
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  it("rejects a reclaim attempt whose event type differs from what was originally claimed", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const sharedEventId = crypto.randomUUID();

    // Originally claimed as a "failed" event, interrupted before
    // processing.
    await prisma.$executeRaw`
      INSERT INTO payment_events (id, payment_id, provider, external_event_id, event_type, raw_payload, signature_valid, received_at)
      VALUES (${crypto.randomUUID()}, ${fixture.payment.id}, 'fake', ${sharedEventId}, 'payment.failed', '{}'::jsonb, true, now())
    `;

    const payload = {
      eventId: sharedEventId,
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
    };
    const response = await post(payload);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "EVENT_COLLISION" });

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);
  });

  it("rejects a forged/tampered signature and leaves order state unchanged", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = makePayload(fixture, "payment.succeeded");

    const response = await post(payload, "0".repeat(64));
    expect(response.status).toBe(401);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("pending_payment");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);
  });

  it("marks the order paid_but_unfulfillable when the hold expired before payment arrived, without overselling", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });

    // Simulate the reservation having already expired (and its stock
    // potentially resold) by the time the late payment confirmation
    // arrives.
    await prisma.reservation.update({ where: { id: fixture.reservationId }, data: { status: "expired" } });

    const response = await post(makePayload(fixture, "payment.succeeded"));
    expect(response.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid_but_unfulfillable");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);
  });

  it("never generates tickets before a payment.succeeded event is received", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("pending_payment");
  });

  it("releases the hold's stock back to inventory on a failed payment", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const response = await post(makePayload(fixture, "payment.failed"));
    expect(response.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("failed");

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(0);
  });

  it("a failed event arriving after an already-succeeded event never overwrites Payment.status or revokes tickets", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await post(makePayload(fixture, "payment.succeeded"));

    const response = await post(makePayload(fixture, "payment.failed"));
    expect(response.status).toBe(200); // acknowledged, but a no-op

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid");

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  // --- Reconciliation: a payment.succeeded arriving after failed/cancelled ---
  //
  // The real PSP hasn't been selected, so its actual event lifecycle is
  // unknown — this app must never assume a "failed" or "cancelled" order
  // can't later receive a validly-signed "succeeded" event, and it must
  // never silently ignore evidence that money was captured. See
  // docs/PAYMENTS.md and lib/orders/fulfillment.ts::reconcileContradictorySuccess.

  it("a succeeded event after an already-failed event fulfills the order when inventory is still available", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await post(makePayload(fixture, "payment.failed"));

    // Nobody else took the released stock, so reconciliation must be
    // able to fulfill it directly rather than leaving a captured payment
    // stranded on a "failed" order.
    const response = await post(makePayload(fixture, "payment.succeeded"));
    expect(response.status).toBe(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid"); // money was captured — never hidden

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.soldQuantity).toBe(1);
    expect(inventory.reservedQuantity).toBe(0);

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: fixture.order.id, action: "payment.contradictory_success_reconciled_and_fulfilled" },
    });
    expect(auditEntries).toHaveLength(1);
  });

  it("a succeeded event after an already-failed event requires reconciliation once the stock was resold, without overselling", async () => {
    // total=1: once failed releases it, a second buyer immediately takes
    // the only unit, so it's genuinely gone by the time the late
    // succeeded event arrives.
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await post(makePayload(fixture, "payment.failed"));

    const { createHold } = await import("@/lib/inventory");
    const otherBuyer = await prisma.user.create({
      data: { email: `other-${crypto.randomUUID()}@test.onlylive.ma`, passwordHash: "x", name: "Other buyer" },
    });
    await createHold({
      ticketCategoryId: fixture.category.id,
      salesPhaseId: fixture.phase.id,
      userId: otherBuyer.id,
      quantity: 1,
    });

    const response = await post(makePayload(fixture, "payment.succeeded"));
    expect(response.status).toBe(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid"); // money was still captured — must not be hidden

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("reconciliation_required");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0); // never oversell

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.reservedQuantity + inventory.soldQuantity).toBe(1); // still exactly the other buyer's unit

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: fixture.order.id, action: "payment.contradictory_success_requires_reconciliation" },
    });
    expect(auditEntries).toHaveLength(1);
  });

  it("a succeeded event after an already-cancelled event is reconciled the same way", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await post(makePayload(fixture, "payment.cancelled"));

    const response = await post(makePayload(fixture, "payment.succeeded"));
    expect(response.status).toBe(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid");

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("simultaneous succeeded and failed events for the same payment converge on paid when inventory is still available", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });

    const [successResponse, failResponse] = await Promise.all([
      post(makePayload(fixture, "payment.succeeded")),
      post(makePayload(fixture, "payment.failed")),
    ]);
    expect([successResponse.status, failResponse.status]).toEqual([200, 200]);

    // Whichever event's transaction wins the Payment row lock first, the
    // outcome is now deterministic: either succeeded applies directly,
    // or failed applies first and is then reconciled back to paid since
    // nothing else consumed the stock. The order must never be left
    // "failed" while money was captured.
    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("rejects a webhook claiming the wrong amount despite a valid signature", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = makePayload(fixture, "payment.succeeded", { amountCents: fixture.payment.amountCents + 100 });

    const response = await post(payload);
    expect(response.status).toBe(409);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("pending_payment");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);

    const auditEntries = await prisma.auditLog.findMany({
      where: { entityId: fixture.payment.id, action: "payment.amount_mismatch" },
    });
    expect(auditEntries.length).toBeGreaterThan(0);
  });

  it("rejects a webhook claiming the wrong currency despite a valid signature", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = makePayload(fixture, "payment.succeeded", { currency: "USD" });

    const response = await post(payload);
    expect(response.status).toBe(409);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("pending_payment");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);
  });
});
