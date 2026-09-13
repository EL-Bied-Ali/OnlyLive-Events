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

  it("a succeeded event arriving after an already-failed event never retroactively generates tickets", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await post(makePayload(fixture, "payment.failed"));

    const response = await post(makePayload(fixture, "payment.succeeded"));
    expect(response.status).toBe(200);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("failed");

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("failed");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(0);
  });

  it("simultaneous succeeded and failed events for the same payment settle on exactly one outcome, never both", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });

    const [successResponse, failResponse] = await Promise.all([
      post(makePayload(fixture, "payment.succeeded")),
      post(makePayload(fixture, "payment.failed")),
    ]);
    expect([successResponse.status, failResponse.status]).toEqual([200, 200]);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(["paid", "failed"]).toContain(order.status);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe(order.status);

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(order.status === "paid" ? 1 : 0);
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
