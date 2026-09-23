import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { POST as fakeWebhookPost } from "@/app/api/payments/webhook/fake/route";
import { initiateRefund, reconcileProcessingRefunds } from "@/lib/orders/refund";
import { reconcileProcessingRefundsFair } from "@/lib/orders/refundReconciliation";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "fairness"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "fairness-webhook-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
  vi.stubEnv("VERCEL_ENV", "preview");
  vi.stubEnv("VERCEL_AUTOMATION_BYPASS_SECRET", "test-automation-bypass-secret");
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

const processingRefundIds = new Set<string>();

async function createProcessingRefund(queueOffsetMs: number) {
  const fixture = await createOrderAwaitingPayment({ quantity: 1, priceCents: 5_000 });

  // The route itself is pinned to the fake provider, so the global default
  // intentionally remains ChariPay while this fake Payment is confirmed.
  const paid = await fakeWebhookPost(fakeWebhookRequest({
    eventId: crypto.randomUUID(),
    providerPaymentId: fixture.payment.providerPaymentId,
    type: "payment.succeeded",
    amountCents: fixture.payment.amountCents,
    currency: fixture.payment.currency,
  }));
  expect(paid.status).toBe(200);

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
  const queuePosition = new Date(Date.UTC(2000, 0, 1) + queueOffsetMs);
  await prisma.$executeRaw`
    UPDATE refunds SET created_at = ${queuePosition}, updated_at = ${queuePosition}
    WHERE id = ${initiated.refundId}
  `;
  processingRefundIds.add(initiated.refundId);
  return initiated.refundId;
}

describe("fair refund reconciliation", () => {
  afterEach(async () => {
    if (processingRefundIds.size > 0) {
      await prisma.refund.deleteMany({
        where: { id: { in: [...processingRefundIds] }, status: "processing" },
      });
      processingRefundIds.clear();
    }
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

    const oldest = await createProcessingRefund(0);
    const second = await createProcessingRefund(1_000);
    const later = await createProcessingRefund(2_000);

    const firstRun = await reconcileProcessingRefunds(2);
    expect(firstRun).toMatchObject({ checked: 2, pending: 2, errors: 0 });
    const firstReferences = statusSpy.mock.calls.slice(0, 2).map(([reference]) => reference);
    expect(new Set(firstReferences)).toEqual(new Set([oldest, second]));

    const secondRun = await reconcileProcessingRefunds(1);
    expect(secondRun).toMatchObject({ checked: 1, pending: 1, errors: 0 });
    expect(statusSpy.mock.calls[2]?.[0]).toBe(later);
  });

  it("claims later batch rows only when their provider work is about to begin", async () => {
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: null, state: "processing" });

    const first = await createProcessingRefund(0);
    const second = await createProcessingRefund(1_000);
    let observedSecondUpdatedAtMs: number | undefined;
    vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockImplementation(async (reference) => {
      if (reference === first) {
        const secondRow = await prisma.refund.findUniqueOrThrow({
          where: { id: second },
          select: { updatedAt: true },
        });
        observedSecondUpdatedAtMs = secondRow.updatedAt.getTime();
      }
      return { providerRefundId: null, status: "pending" };
    });

    const result = await reconcileProcessingRefundsFair(2);
    expect(result).toMatchObject({ checked: 2, pending: 2, errors: 0 });
    expect(observedSecondUpdatedAtMs).toBe(Date.UTC(2000, 0, 1) + 1_000);
  });

  it("lets concurrent workers claim different refunds instead of processing one row twice", async () => {
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "refund").mockResolvedValue({ providerRefundId: null, state: "processing" });
    const statusSpy = vi.spyOn(ChariPayProvider.prototype, "getRefundStatus").mockResolvedValue({
      providerRefundId: null,
      status: "pending",
    });

    const first = await createProcessingRefund(0);
    const second = await createProcessingRefund(1_000);

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
