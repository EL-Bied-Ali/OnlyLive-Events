import crypto from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/db";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { ProviderRequestError } from "@/lib/payments/provider";
import { reconcileOrderPaymentOnDemand } from "@/lib/orders/paymentReconciliation";
import { POST as chariWebhookPost } from "@/app/api/payments/webhook/charipay/route";
import { createOrderAwaitingPayment } from "../helpers/fixtures";

// Only finalizeRecoveredPayment is ever overridden (and only in one test
// below, to force its "cannot safely finalize from here" branch on demand
// without faking a real concurrent state change) — every other export,
// including recordPaymentReconciliationAttention itself, keeps its real
// implementation so the dedup/audit behavior under test is genuine.
vi.mock("@/lib/orders/checkoutReconciliation", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/orders/checkoutReconciliation")>();
  return { ...actual, finalizeRecoveredPayment: vi.fn(actual.finalizeRecoveredPayment) };
});

const WEBHOOK_SECRET = "order-reconcile-on-demand-webhook-secret";

function enableChariPay() {
  vi.stubEnv("PAYMENT_PROVIDER", "charipay");
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", ["chari", "sk", "test", "order-reconcile"].join("_"));
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", WEBHOOK_SECRET);
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.example/");
}

async function createChariPendingOrder(options: { quantity?: number; priceCents?: number } = {}) {
  const fixture = await createOrderAwaitingPayment(options);
  const providerPaymentId = `ps_${crypto.randomUUID()}`;
  const payment = await prisma.payment.update({
    where: { id: fixture.payment.id },
    data: { provider: "charipay", providerPaymentId },
  });
  return { ...fixture, payment };
}

// Matches the real signed sandbox payload shape used by the ChariPay
// webhook test suite (charipay-webhook.test.ts) — ExternalId/Reference/
// CustomData carry the ORDER id; only metadata.onlylivePaymentId resolves
// the actual Payment row.
function paymentPayload(paymentId: string, orderId: string, amountCents: number) {
  return {
    Amount: amountCents / 100,
    ExternalId: orderId,
    Reference: orderId,
    CustomData: orderId,
    metadata: { onlylivePaymentId: paymentId, onlyliveOrderId: orderId },
  };
}

function signedWebhookRequest(payload: unknown) {
  const rawBody = JSON.stringify(payload);
  const timestamp = String(Date.now());
  const signature = crypto.createHmac("sha256", WEBHOOK_SECRET).update(`${timestamp}.${rawBody}`).digest("hex");
  return new NextRequest("https://preview.onlylive.example/api/payments/webhook/charipay", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-chari-signature": signature,
      "x-chari-timestamp": timestamp,
      "chari-event-id": crypto.randomUUID(),
      "chari-event-type": "payment.succeeded",
    },
    body: rawBody,
  });
}

describe("reconcileOrderPaymentOnDemand", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("finalizes a pending order exactly like a webhook when the ChariPay ledger reports SUCCESS", async () => {
    const fixture = await createChariPendingOrder({ quantity: 2, priceCents: 5_000 });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-succeeded",
      providerStatus: "SUCCESS",
    });

    const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(result).toEqual({ status: "paid", reconciled: true });

    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } })).resolves.toMatchObject({ status: "converted" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(2);

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.soldQuantity).toBe(2);
    expect(inventory.reservedQuantity).toBe(0);

    const emails = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.recipientEmail).toBe(fixture.user.email);
  });

  it("keeps a PENDING_3DS order pending without creating a ticket, releasing stock, or a second payment", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "pending",
      providerOperationId: "op-pending",
      providerStatus: "PENDING_3DS",
    });

    const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(result).toEqual({ status: "pending_payment", reconciled: false });

    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "awaiting_payment" });
    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } })).resolves.toMatchObject({ status: "active" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    expect(await prisma.payment.count({ where: { orderId: fixture.order.id } })).toBe(1);
  });

  it("fails closed on an ambiguous provider ledger result", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "ambiguous",
      providerStatus: "MULTIPLE_EXACT_MATCHES",
    });

    const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(result).toEqual({ status: "pending_payment", reconciled: false });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } })).resolves.toMatchObject({ status: "active" });
    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.reservedQuantity).toBe(1);
  });

  it("fails closed when the provider ledger lookup throws (timeout/error)", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockRejectedValue(
      new ProviderRequestError("request timed out", true, undefined, undefined, "corr-timeout"),
    );

    const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(result).toEqual({ status: "pending_payment", reconciled: false });
    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } })).resolves.toMatchObject({ status: "active" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("treats failed/cancelled/not_found ledger results as inconclusive, never releasing inventory itself", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    const lookup = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus");

    for (const status of ["failed", "cancelled", "not_found"] as const) {
      lookup.mockResolvedValueOnce({ status });
      const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
      expect(result).toEqual({ status: "pending_payment", reconciled: false });
    }

    await expect(prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } })).resolves.toMatchObject({ status: "active" });
    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "pending_payment" });
  });

  it("never records reconciliation-required audit noise for routine pending/error polls, and never lets those suppress a later serious reason", async () => {
    const fixture = await createChariPendingOrder();
    enableChariPay();
    const lookup = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus");
    const auditFilter = {
      action: "payment.checkout_reconciliation_required",
      entityType: "Payment",
      entityId: fixture.payment.id,
    } as const;

    // A payment sitting in PENDING_3DS seconds into an active checkout is
    // completely normal for this fast polling path — must not consume the
    // shared, dedup-by-payment audit slot.
    lookup.mockResolvedValueOnce({ status: "pending", providerOperationId: "op-pending", providerStatus: "PENDING_3DS" });
    await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(await prisma.auditLog.count({ where: auditFilter })).toBe(0);

    // An ambiguous ledger match during active polling is likewise routine
    // fail-closed behavior, not an admin-actionable event on its own.
    lookup.mockResolvedValueOnce({ status: "ambiguous", providerStatus: "MULTIPLE_EXACT_MATCHES" });
    await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(await prisma.auditLog.count({ where: auditFilter })).toBe(0);

    // A single transient provider error/timeout during active polling is
    // also routine — the customer must not lose their reservation over it,
    // and it must not be recorded as if it were a stuck/expired checkout.
    lookup.mockRejectedValueOnce(new ProviderRequestError("request timed out", true, undefined, undefined, "corr-timeout"));
    await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(await prisma.auditLog.count({ where: auditFilter })).toBe(0);

    // Now the genuinely serious case: the ledger reports SUCCESS but the
    // payment cannot be safely finalized from here (finalizeRecoveredPayment
    // is forced to report this once, standing in for the real underlying
    // condition — e.g. the reservation/order having moved in a way that
    // makes local fulfillment unsafe — without needing to fabricate that
    // exact concurrent scenario). This IS admin-actionable and must be
    // recorded, proving the routine polls above never silently claimed the
    // one audit slot this serious condition needed.
    lookup.mockResolvedValueOnce({ status: "succeeded", providerOperationId: "op-ambiguous", providerStatus: "SUCCESS" });
    const { finalizeRecoveredPayment } = await import("@/lib/orders/checkoutReconciliation");
    vi.mocked(finalizeRecoveredPayment).mockResolvedValueOnce(false);

    const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(result.reconciled).toBe(false);
    expect(await prisma.auditLog.count({ where: auditFilter })).toBe(1);
    const [row] = await prisma.auditLog.findMany({ where: auditFilter });
    expect(row!.metadata).toMatchObject({ reason: "customer_triggered_transaction_success_local_state_ambiguous" });
  });

  it("is a harmless no-op on an already-paid order and never calls the provider again", async () => {
    const fixture = await createChariPendingOrder({ priceCents: 10_000 });
    enableChariPay();
    const lookup = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-idempotent",
      providerStatus: "SUCCESS",
    });

    const first = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(first.reconciled).toBe(true);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(1);

    const second = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(second).toEqual({ status: "paid", reconciled: false });

    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(1);
    const emails = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(emails).toHaveLength(1);
    // The second call short-circuits on order.status !== "pending_payment"
    // before resolving the provider at all.
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("does not duplicate fulfillment when two on-demand reconciliation calls race each other", async () => {
    const fixture = await createChariPendingOrder({ quantity: 3, priceCents: 4_000 });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-race",
      providerStatus: "SUCCESS",
    });

    const [first, second] = await Promise.all([
      reconcileOrderPaymentOnDemand(fixture.order.id),
      reconcileOrderPaymentOnDemand(fixture.order.id),
    ]);

    // Depending on exactly how the two calls interleave, the loser of the
    // Payment row lock either observes "already paid" from inside
    // finalizeRecoveredPayment (reconciled: true) or finds no matching
    // pending/awaiting_payment row at its own initial read and short-circuits
    // (reconciled: false) — both are correct outcomes of the SAME underlying
    // idempotency guarantee. What must always hold regardless of interleaving
    // is that both calls observe the final authoritative status, and that the
    // fulfillment itself (tickets/inventory/email) happened exactly once.
    expect(first.status).toBe("paid");
    expect(second.status).toBe("paid");
    expect([first.reconciled, second.reconciled].some(Boolean)).toBe(true);
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(3);
    const emails = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(emails).toHaveLength(1);
    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.soldQuantity).toBe(3);
    expect(inventory.reservedQuantity).toBe(0);
  });

  it("produces exactly one fulfillment outcome when on-demand reconciliation races a real signed webhook delivery", async () => {
    const fixture = await createChariPendingOrder({ quantity: 1, priceCents: 15_000 });
    enableChariPay();
    vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "op-webhook-race",
      providerStatus: "SUCCESS",
    });

    const webhookRequest = signedWebhookRequest(
      paymentPayload(fixture.payment.id, fixture.order.id, fixture.payment.amountCents),
    );

    const [onDemand, webhookResponse] = await Promise.all([
      reconcileOrderPaymentOnDemand(fixture.order.id),
      chariWebhookPost(webhookRequest),
    ]);

    expect(webhookResponse.status).toBe(200);
    expect(onDemand.status).toBe("paid");

    await expect(prisma.order.findUniqueOrThrow({ where: { id: fixture.order.id } })).resolves.toMatchObject({ status: "paid" });
    await expect(prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } })).resolves.toMatchObject({ status: "paid" });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(1);

    const emails = await prisma.emailOutbox.findMany({
      where: { type: "order_confirmation", entityType: "order", entityId: fixture.order.id },
    });
    expect(emails).toHaveLength(1);

    const inventory = await prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } });
    expect(inventory.soldQuantity).toBe(1);
    expect(inventory.reservedQuantity).toBe(0);
  });

  it("does not attempt a provider lookup for a provider without lookupPaymentStatus support", async () => {
    const fixture = await createOrderAwaitingPayment();
    // Left on the default "fake" provider, which has no lookupPaymentStatus.
    const result = await reconcileOrderPaymentOnDemand(fixture.order.id);
    expect(result).toEqual({ status: "pending_payment", reconciled: false });
    expect(await prisma.ticket.count({ where: { eventId: fixture.event.id } })).toBe(0);
  });

  it("returns not_found for a nonexistent order id without throwing", async () => {
    await expect(reconcileOrderPaymentOnDemand(crypto.randomUUID())).resolves.toEqual({
      status: "not_found",
      reconciled: false,
    });
  });
});
