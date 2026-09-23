import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { createOrderAwaitingPayment, createTestUser } from "../helpers/fixtures";

// requireCustomer() reads the session via next/headers, which needs a real
// Next.js request context a plain Vitest/Node process doesn't provide (see
// tests/integration/access-control.test.ts and customerPhone.test.ts).
// Mocking it lets this test exercise the route's own auth/ownership/rate-
// limit/response-shape logic directly.
vi.mock("@/lib/auth/customer", () => ({
  requireCustomer: vi.fn(),
}));

async function importRoute() {
  return import("@/app/api/orders/[orderId]/reconcile-payment/route");
}

function postRequest(orderId: string) {
  return new NextRequest(`http://localhost/api/orders/${orderId}/reconcile-payment`, { method: "POST" });
}

function context(orderId: string) {
  return { params: Promise.resolve({ orderId }) };
}

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "order-reconcile-route"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "order-reconcile-route-webhook-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
}

async function createChariPendingOrder() {
  const fixture = await createOrderAwaitingPayment();
  await prisma.payment.update({ where: { id: fixture.payment.id }, data: { provider: "charipay", providerPaymentId: `ps_${fixture.payment.id}` } });
  return fixture;
}

describe("POST /api/orders/[orderId]/reconcile-payment", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects an unauthenticated request", async () => {
    const { requireCustomer } = await import("@/lib/auth/customer");
    const { ApiError } = await import("@/lib/http/errors");
    vi.mocked(requireCustomer).mockRejectedValue(new ApiError(401, "UNAUTHENTICATED", "Sign-in required"));

    const { POST } = await importRoute();
    const response = await POST(postRequest("nonexistent"), context("nonexistent"));
    expect(response.status).toBe(401);
  });

  it("returns 404 for another customer's order without confirming it exists", async () => {
    const owner = await createTestUser("reconcile-owner");
    const stranger = await createTestUser("reconcile-stranger");
    const fixture = await createChariPendingOrder();
    await prisma.order.update({ where: { id: fixture.order.id }, data: { userId: owner.id } });

    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: stranger.id, email: stranger.email, name: stranger.name });

    const { POST } = await importRoute();
    const response = await POST(postRequest(fixture.order.id), context(fixture.order.id));
    expect(response.status).toBe(404);
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
  });

  it("reconciles the signed-in owner's own pending order and returns only status/reconciled, never provider data", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-route",
      providerStatus: "SUCCESS",
    });

    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: fixture.user.id, email: fixture.user.email, name: fixture.user.name });

    const { POST } = await importRoute();
    const response = await POST(postRequest(fixture.order.id), context(fixture.order.id));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ status: "paid", reconciled: true });
    // The client must never receive PSP credentials, operation ids, or raw
    // ledger fields — only the order's own status.
    expect(Object.keys(body).sort()).toEqual(["reconciled", "status"]);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toMatch(/chari_sk_|op-route|SUCCESS|providerOperationId|providerStatus/);
  });

  it("is a harmless no-op for an already-terminal order and never touches the provider or the rate limit", async () => {
    const fixture = await createChariPendingOrder();
    await prisma.order.update({ where: { id: fixture.order.id }, data: { status: "paid" } });
    enableChariPay();
    const lookup = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus");

    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: fixture.user.id, email: fixture.user.email, name: fixture.user.name });

    const { POST } = await importRoute();
    const response = await POST(postRequest(fixture.order.id), context(fixture.order.id));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "paid", reconciled: false });
    expect(lookup).not.toHaveBeenCalled();
  });

  it("throttles excessive reconciliation requests for the same order instead of hammering the provider", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    const lookup = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "pending",
      providerOperationId: "op-throttle",
      providerStatus: "PENDING_3DS",
    });

    const { requireCustomer } = await import("@/lib/auth/customer");
    vi.mocked(requireCustomer).mockResolvedValue({ id: fixture.user.id, email: fixture.user.email, name: fixture.user.name });

    const { POST } = await importRoute();
    const first = await POST(postRequest(fixture.order.id), context(fixture.order.id));
    expect(first.status).toBe(200);

    const second = await POST(postRequest(fixture.order.id), context(fixture.order.id));
    expect(second.status).toBe(429);
    expect(second.headers.get("Retry-After")).toBeTruthy();
    const body = await second.json();
    expect(body).toMatchObject({ status: "pending_payment", reconciled: false, throttled: true });

    // Only the first, accepted call actually reached the provider.
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});
