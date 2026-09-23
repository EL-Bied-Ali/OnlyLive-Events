import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

// requireCustomer() reads the session via next/headers, which needs a real
// Next.js request context a plain Vitest/Node process doesn't provide (see
// tests/integration/customerPhone.test.ts for the same established pattern).
vi.mock("@/lib/auth/customer", () => ({
  requireCustomer: vi.fn(),
}));

const scheduleEagerEmailDispatchMock = vi.fn();
vi.mock("@/lib/email/eagerDispatch", () => ({
  scheduleEagerEmailDispatch: scheduleEagerEmailDispatchMock,
}));

async function importRoute() {
  return import("@/app/api/orders/[orderId]/reconcile-payment/route");
}

function request() {
  return new NextRequest("http://localhost/api/orders/order-id/reconcile-payment", { method: "POST" });
}

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "reconcile-route"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "reconcile-route-webhook-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
}

async function asCustomer(userId: string, email: string | null, name: string | null) {
  const { requireCustomer } = await import("@/lib/auth/customer");
  vi.mocked(requireCustomer).mockResolvedValue({ id: userId, email, name });
}

describe("POST /api/orders/[orderId]/reconcile-payment eager dispatch", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    scheduleEagerEmailDispatchMock.mockClear();
  });

  it("does not schedule eager dispatch for the overwhelmingly common no-op poll (order already resolved)", async () => {
    const fixture = await createOrderAwaitingPayment();
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "paid" } });
    await asCustomer(fixture.user.id, fixture.user.email, fixture.user.name);

    const { POST } = await importRoute();
    const response = await POST(request(), { params: Promise.resolve({ orderId: fixture.order.id }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reconciled: false });
    expect(scheduleEagerEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("does not schedule eager dispatch when the provider ledger has nothing new to report", async () => {
    const fixture = await createOrderAwaitingPayment();
    const providerPaymentId = `ps_${crypto.randomUUID()}`;
    await prisma.payment.update({ where: { id: fixture.payment.id }, data: { provider: "charipay", providerPaymentId } });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "pending",
      providerOperationId: "op-pending",
      providerStatus: "PENDING_3DS",
    });
    await asCustomer(fixture.user.id, fixture.user.email, fixture.user.name);

    const { POST } = await importRoute();
    const response = await POST(request(), { params: Promise.resolve({ orderId: fixture.order.id }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reconciled: false });
    expect(scheduleEagerEmailDispatchMock).not.toHaveBeenCalled();
  });

  it("schedules eager dispatch exactly when a payment is actually recovered and finalized", async () => {
    const fixture = await createOrderAwaitingPayment();
    const providerPaymentId = `ps_${crypto.randomUUID()}`;
    await prisma.payment.update({ where: { id: fixture.payment.id }, data: { provider: "charipay", providerPaymentId } });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-succeeded",
      providerStatus: "SUCCESS",
    });
    await asCustomer(fixture.user.id, fixture.user.email, fixture.user.name);

    const { POST } = await importRoute();
    const response = await POST(request(), { params: Promise.resolve({ orderId: fixture.order.id }) });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ reconciled: true, status: "paid" });
    expect(scheduleEagerEmailDispatchMock).toHaveBeenCalledTimes(1);
  });
});
