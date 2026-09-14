import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { FakeProvider, signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { POST as fakeWebhookPost } from "@/app/api/payments/webhook/fake/route";
import { finalizeRefundSuccess, initiateRefund, reconcileProcessingRefunds } from "@/lib/orders/refund";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function fakeWebhookRequest(payload: unknown) {
  const body = JSON.stringify(payload);
  return new NextRequest("http://localhost/api/payments/webhook/fake", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-onlylive-fake-signature": signFakeWebhookPayload(body),
    },
    body,
  });
}

async function markFixturePaid(fixture: Awaited<ReturnType<typeof createOrderAwaitingPayment>>) {
  const response = await fakeWebhookPost(fakeWebhookRequest({
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type: "payment.succeeded",
    amountCents: fixture.payment.amountCents,
    currency: fixture.payment.currency,
  }));
  expect(response.status).toBe(200);
}

async function createPaidOrderForChariPay(options: { quantity?: number; priceCents?: number } = {}) {
  const fixture = await createOrderAwaitingPayment(options);
  await markFixturePaid(fixture);
  const payment = await prisma.payment.update({
    where: { id: fixture.payment.id },
    data: { provider: "charipay", providerPaymentId: `ps_${crypto.randomUUID()}` },
  });
  return { ...fixture, payment };
}

async function createAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `charipay-refund-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used-in-tests",
      name: "ChariPay Refund Admin",
      role: "admin",
    },
  });
}

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "refund", "integration"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "integration-webhook-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
  vi.stubEnv("VERCEL_ENV", "preview");
}

async function ageRefund(refundId: string) {
  await prisma.refund.update({ where: { id: refundId }, data: { createdAt: new Date(Date.now() - 60_000) } });
}

describe("ChariPay asynchronous refund reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("finalizes a processing refund when GET status reports SUCCESS", async () => {
    const fixture = await createPaidOrderForChariPay({ quantity: 1, priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_reconcile_success", state: "processing" });
    vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({ providerRefundId: "rf_reconcile_success", status: "succeeded" });
    const initiated = await initiateRefund({ paymentId: fixture.payment.id, amountCents: fixture.payment.amountCents, reason: "Webhook loss fallback", actorId: admin.id });
    await ageRefund(initiated.refundId);
    const summary = await reconcileProcessingRefunds();
    expect(summary).toMatchObject({ checked: 1, succeeded: 1, errors: 0 });
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "succeeded" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "refunded" });
  });

  it("marks processing refund failed when provider status reports FAILED", async () => {
    const fixture = await createPaidOrderForChariPay({ priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_reconcile_failed", state: "processing" });
    vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({ providerRefundId: "rf_reconcile_failed", status: "failed" });
    const initiated = await initiateRefund({ paymentId: fixture.payment.id, amountCents: fixture.payment.amountCents, reason: "Failed refund", actorId: admin.id });
    await ageRefund(initiated.refundId);
    const summary = await reconcileProcessingRefunds();
    expect(summary).toMatchObject({ checked: 1, failed: 1, errors: 0 });
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "failed" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
  });

  it("replays exactly the same refundReference when lookup says not_found", async () => {
    const fixture = await createPaidOrderForChariPay({ priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    const refundSpy = vi.spyOn(ChariPayProvider.prototype, "refund")
      .mockResolvedValueOnce({ providerRefundId: null, state: "processing" })
      .mockResolvedValueOnce({ providerRefundId: "rf_after_replay", state: "processing" });
    const statusSpy = vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({ providerRefundId: null, status: "not_found" });
    const initiated = await initiateRefund({ paymentId: fixture.payment.id, amountCents: fixture.payment.amountCents, reason: "Ambiguous first submission", actorId: admin.id });
    await ageRefund(initiated.refundId);
    const summary = await reconcileProcessingRefunds();
    expect(summary).toMatchObject({ checked: 1, replayed: 1, pending: 1, errors: 0 });
    expect(statusSpy).toHaveBeenCalledWith(initiated.refundId);
    expect(refundSpy).toHaveBeenCalledTimes(2);
    expect(refundSpy.mock.calls[0]![0].idempotencyKey).toBe(initiated.refundId);
    expect(refundSpy.mock.calls[1]![0].idempotencyKey).toBe(initiated.refundId);
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing", providerRefundId: "rf_after_replay" });
  });

  it("keeps an ambiguous network failure processing and reserves the same refund reference", async () => {
    const fixture = await createPaidOrderForChariPay({ priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockRejectedValue(new TypeError("simulated network timeout"));
    await expect(initiateRefund({ paymentId: fixture.payment.id, amountCents: 7_000, reason: "Ambiguous network outcome", actorId: admin.id }))
      .rejects.toMatchObject({ code: "PROVIDER_REFUND_STATUS_UNKNOWN", status: 502 });
    const processing = await prisma.refund.findFirstOrThrow({ where: { paymentId: fixture.payment.id } });
    expect(processing.status).toBe("processing");
    await expect(initiateRefund({ paymentId: fixture.payment.id, amountCents: 4_000, reason: "Must remain reserved", actorId: admin.id }))
      .rejects.toMatchObject({ code: "REFUND_EXCEEDS_REMAINING", status: 409 });
  });

  it("leaves a pending provider refund processing without replaying it", async () => {
    const fixture = await createPaidOrderForChariPay({ priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    const refundSpy = vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_pending", state: "processing" });
    vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({ providerRefundId: "rf_pending", status: "pending" });
    const initiated = await initiateRefund({ paymentId: fixture.payment.id, amountCents: fixture.payment.amountCents, reason: "Still pending", actorId: admin.id });
    await ageRefund(initiated.refundId);
    const summary = await reconcileProcessingRefunds();
    expect(summary.pending).toBeGreaterThanOrEqual(1);
    expect(summary.replayed).toBe(0);
    expect(summary.errors).toBe(0);
    expect(refundSpy).toHaveBeenCalledTimes(1);
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing", providerRefundId: "rf_pending" });
  });

  it("rechecks provider refund evidence inside the finalizer transaction", async () => {
    const fixture = await createPaidOrderForChariPay({ priceCents: 10_000 });
    const admin = await createAdmin();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_expected", state: "processing" });
    const initiated = await initiateRefund({ paymentId: fixture.payment.id, amountCents: fixture.payment.amountCents, reason: "Atomic evidence guard", actorId: admin.id });
    await expect(finalizeRefundSuccess(initiated.refundId, "rf_conflicting", {
      provider: "charipay",
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
      paymentExternalId: fixture.payment.id,
      providerPaymentId: fixture.payment.providerPaymentId!,
      providerRefundId: "rf_conflicting",
    })).rejects.toMatchObject({ code: "REFUND_INTEGRITY_MISMATCH", status: 409 });
    await expect(prisma.refund.findUniqueOrThrow({ where: { id: initiated.refundId } })).resolves.toMatchObject({ status: "processing", providerRefundId: "rf_expected" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
  });

  it("routes a historical fake payment through its persisted provider after the default changes to ChariPay", async () => {
    const fixture = await createOrderAwaitingPayment({ priceCents: 10_000 });
    await markFixturePaid(fixture);
    const admin = await createAdmin();
    enableChariPay();
    const fakeSpy = vi.spyOn(FakeProvider.prototype, "refund");
    const chariSpy = vi.spyOn(ChariPayProvider.prototype, "refund");

    const result = await initiateRefund({
      paymentId: fixture.payment.id,
      amountCents: fixture.payment.amountCents,
      reason: "Historical provider routing",
      actorId: admin.id,
    });

    expect(result.state).toBe("succeeded");
    expect(fakeSpy).toHaveBeenCalledTimes(1);
    expect(chariSpy).not.toHaveBeenCalled();
    await expect(prisma.refund.findFirstOrThrow({ where: { paymentId: fixture.payment.id } })).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps used tickets used and never restocks them on a full refund", async () => {
    const fixture = await createPaidOrderForChariPay({ quantity: 2, priceCents: 10_000 });
    const admin = await createAdmin();
    const tickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id }, orderBy: { createdAt: "asc" } });
    await prisma.ticket.update({ where: { id: tickets[0]!.id }, data: { status: "used", usedAt: new Date() } });
    const inventoryBefore = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: "rf_used_ticket", state: "succeeded" });
    await initiateRefund({ paymentId: fixture.payment.id, amountCents: fixture.payment.amountCents, reason: "Full refund after one scan", actorId: admin.id });
    const afterTickets = await prisma.ticket.findMany({ where: { orderItemId: fixture.orderItem.id }, orderBy: { createdAt: "asc" } });
    expect(afterTickets.map((ticket) => ticket.status).sort()).toEqual(["cancelled", "used"]);
    const inventoryAfter = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventoryAfter.soldQuantity).toBe(inventoryBefore.soldQuantity - 1);
  });
});
