import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { POST as fakeWebhookPost } from "@/app/api/payments/webhook/fake/route";
import { initiateRefund } from "@/lib/orders/refund";
import { reconcileProcessingRefundsFair } from "@/lib/orders/refundReconciliation";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "fairness"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "fairness-webhook-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
  vi.stubEnv("VERCEL_ENV", "preview");
}

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

async function createAdmin() {
  return prisma.adminUser.create({
    data: {
      email: `refund-fairness-${crypto.randomUUID()}@test.onlylive.ma`,
      passwordHash: "not-used",
      name: "Refund Fairness Admin",
      role: "admin",
    },
  });
}

async function createProcessingRefund(ageMs: number) {
  const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 5_000 });

  // Fixtures are created for the fake provider. Confirm the order through that
  // provider first, then switch the persisted payment to ChariPay so the test
  // exercises only the async-refund reconciler rather than the webhook router.
  vi.stubEnv("PAYMENT_PROVIDER", "fake");
  const paid = await fakeWebhookPost(fakeWebhookRequest({
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type: "payment.succeeded",
    amountCents: fixture.payment.amountCents,
    currency: fixture.payment.currency,
  }));
  expect(paid.status).toBe(200);
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");

  await prisma.payment.update({
    where: { id: fixture.payment.id },
    data: { provider: "charipay", providerPaymentId: `ps_${crypto.randomUUID()}` },
  });

  const admin = await createAdmin();
  const initiated = await initiateRefund({
    paymentId: fixture.payment.id,
    amountCents: fixture.payment.amountCents,
    reason: "Fairness test",
    actorId: admin.id,
  });
  const aged = new Date(Date.now() - ageMs);
  await prisma.$executeRaw`
    UPDATE refunds SET created_at = ${aged}, updated_at = ${aged}
    WHERE id = ${initiated.refundId}
  `;
  return initiated.refundId;
}

describe("fair refund reconciliation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rotates pending rows so later refunds are not starved by a full pending batch", async () => {
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: null, state: "processing" });
    const statusSpy = vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({
      providerRefundId: null,
      status: "pending",
    });

    const oldest = await createProcessingRefund(120_000);
    const second = await createProcessingRefund(110_000);
    const later = await createProcessingRefund(100_000);

    const firstRun = await reconcileProcessingRefundsFair(2);
    expect(firstRun).toMatchObject({ checked: 2, pending: 2, errors: 0 });
    const firstReferences = statusSpy.mock.calls.slice(0, 2).map(([reference]) => reference);
    expect(new Set(firstReferences)).toEqual(new Set([oldest, second]));

    const secondRun = await reconcileProcessingRefundsFair(2);
    expect(secondRun).toMatchObject({ checked: 1, pending: 1, errors: 0 });
    expect(statusSpy.mock.calls[2]?.[0]).toBe(later);
  });

  it("lets concurrent workers claim different refunds instead of processing one row twice", async () => {
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: null, state: "processing" });
    const statusSpy = vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({
      providerRefundId: null,
      status: "pending",
    });

    const first = await createProcessingRefund(120_000);
    const second = await createProcessingRefund(110_000);

    const results = await Promise.all([
      reconcileProcessingRefundsFair(1),
      reconcileProcessingRefundsFair(1),
    ]);
    expect(results.reduce((sum, result) => sum + result.checked, 0)).toBe(2);
    const references = statusSpy.mock.calls.map(([reference]) => reference);
    expect(references).toHaveLength(2);
    expect(new Set(references)).toEqual(new Set([first, second]));
  });
});
