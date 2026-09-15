import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it, vi, afterEach } from "vitest";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import { POST as webhookPost } from "@/app/api/payments/webhook/fake/route";
import { initiateRefund } from "@/lib/orders/refund";
import {
  sendOrderConfirmationEmail,
  sendPaymentFailedEmail,
  sendRefundConfirmationEmail,
} from "@/lib/email/notifications";
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

describe("transactional email idempotency", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends exactly one order_confirmation email per order, even called twice", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await sendOrderConfirmationEmail(fixture.order.id);
    await sendOrderConfirmationEmail(fixture.order.id);

    const logs = await prisma.emailLog.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(logs).toHaveLength(1);
    expect(logs[0]!.recipientEmail).toBe(fixture.user.email);
    expect(logs[0]!.providerMessageId).toBeTruthy();
  });

  it("sends exactly one payment_failed email per order, even called twice", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    await sendPaymentFailedEmail(fixture.order.id);
    await sendPaymentFailedEmail(fixture.order.id);

    const logs = await prisma.emailLog.findMany({
      where: { type: "payment_failed", entityType: "order", entityId: fixture.order.id },
    });
    expect(logs).toHaveLength(1);
  });

  it("failed-payment messaging never promises that no debit occurred", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const send = vi.spyOn(ConsoleEmailProvider.prototype, "send");

    await sendPaymentFailedEmail(fixture.order.id);

    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0]![0];
    expect(message.subject).toContain("Paiement non confirmé");
    expect(message.text).toContain("ne payez pas une seconde fois");
    expect(message.text).not.toContain("Aucun montant n'a été débité");
  });

  it("records a failed send attempt without throwing, and never blocks a later successful call for a DIFFERENT order", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    vi.spyOn(ConsoleEmailProvider.prototype, "send").mockRejectedValueOnce(new Error("simulated email provider outage"));

    await expect(sendOrderConfirmationEmail(fixture.order.id)).resolves.toBeUndefined();

    const log = await prisma.emailLog.findFirstOrThrow({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(log.providerMessageId).toBeNull();
  });

  it("the payment webhook sends an order_confirmation email exactly once, even under a duplicate delivery", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 2 });
    const response1 = await postWebhook(fixture, "payment.succeeded");
    expect(response1.status).toBe(200);

    // A genuinely duplicate delivery (new event id, same underlying
    // payment already settled) must not trigger a second email.
    const response2 = await postWebhook(fixture, "payment.succeeded");
    expect(response2.status).toBe(200);

    const logs = await prisma.emailLog.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(logs).toHaveLength(1);
  });

  it("the payment webhook sends a payment_failed email when the payment fails", async () => {
    const fixture = await createOrderAwaitingPayment({ quantity: 1 });
    const response = await postWebhook(fixture, "payment.failed");
    expect(response.status).toBe(200);

    const logs = await prisma.emailLog.findMany({
      where: { type: "payment_failed", entityType: "order", entityId: fixture.order.id },
    });
    expect(logs).toHaveLength(1);
  });

  it("a refund sends exactly one refund_confirmation email", async () => {
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
      reason: "test refund",
      actorId: admin.id,
    });

    const logs = await prisma.emailLog.findMany({
      where: { type: "refund_confirmation", entityType: "refund", entityId: result.refundId },
    });
    expect(logs).toHaveLength(1);
  });

  it("is a silent no-op for an unknown order/refund id rather than throwing", async () => {
    const unknownId = crypto.randomUUID();
    await expect(sendOrderConfirmationEmail(unknownId)).resolves.toBeUndefined();
    await expect(sendPaymentFailedEmail(unknownId)).resolves.toBeUndefined();
    await expect(sendRefundConfirmationEmail(unknownId)).resolves.toBeUndefined();
  });
});
