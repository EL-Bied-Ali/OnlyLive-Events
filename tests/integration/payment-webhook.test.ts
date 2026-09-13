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

describe("payment webhook — verification, idempotency, and fulfillment", () => {
  it("confirms payment and generates exactly one ticket per unit for a qty=3 order", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 3 });
    const payload = {
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
    };
    const signature = signFakeWebhookPayload(JSON.stringify(payload));

    const response = await webhookPost(buildWebhookRequest(payload, signature));
    expect(response.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid");

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(3);
    expect(new Set(tickets.map((t) => t.validationToken)).size).toBe(3);
  });

  it("is idempotent under an exact duplicate webhook delivery (same event id)", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = {
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
    };
    const signature = signFakeWebhookPayload(JSON.stringify(payload));

    const first = await webhookPost(buildWebhookRequest(payload, signature));
    const second = await webhookPost(buildWebhookRequest(payload, signature));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("does not double-generate tickets even from two different event ids for the same payment", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const makePayload = () => ({
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded" as const,
      amountCents: fixture.payment.amountCents,
    });

    const payloadA = makePayload();
    const payloadB = makePayload();

    await webhookPost(buildWebhookRequest(payloadA, signFakeWebhookPayload(JSON.stringify(payloadA))));
    await webhookPost(buildWebhookRequest(payloadB, signFakeWebhookPayload(JSON.stringify(payloadB))));

    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id } });
    expect(tickets).toHaveLength(1);
  });

  it("rejects a forged/tampered signature and leaves order state unchanged", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const payload = {
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
    };

    const response = await webhookPost(buildWebhookRequest(payload, "0".repeat(64)));
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

    const payload = {
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
    };
    const signature = signFakeWebhookPayload(JSON.stringify(payload));

    const response = await webhookPost(buildWebhookRequest(payload, signature));
    expect(response.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("paid_but_unfulfillable");

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
    const payload = {
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.failed",
      amountCents: fixture.payment.amountCents,
    };
    const signature = signFakeWebhookPayload(JSON.stringify(payload));

    const response = await webhookPost(buildWebhookRequest(payload, signature));
    expect(response.status).toBe(200);

    const order = await prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } });
    expect(order.status).toBe("failed");

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(0);
  });
});
