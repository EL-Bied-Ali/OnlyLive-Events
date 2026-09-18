import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createHold } from "@/lib/inventory";
import { startCheckout } from "@/lib/orders/checkout";
import { reconcileExpiredCheckouts } from "@/lib/orders/checkoutReconciliation";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { FakeProvider, signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { POST as fakeWebhookPost } from "@/app/api/payments/webhook/fake/route";
import { createTestCategory, createTestUser } from "../helpers/fixtures";

const BASE_URL = "http://localhost:3000";

async function setupExpiredCheckout() {
  const { category, phase } = await createTestCategory(5);
  const user = await createTestUser("checkout-reconcile");
  const hold = await createHold({
    ticketCategoryId: category.id,
    salesPhaseId: phase.id,
    userId: user.id,
    quantity: 1,
  });
  const checkout = await startCheckout(hold.reservationId, user.id, BASE_URL);
  const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: checkout.orderId } });
  const expiredAt = new Date("2001-01-01T00:00:00.000Z");
  await prisma.$transaction([
    prisma.reservation.update({ where: { id: hold.reservationId }, data: { expiresAt: expiredAt } }),
    prisma.order.update({ where: { id: checkout.orderId }, data: { expiresAt: expiredAt } }),
    prisma.payment.update({ where: { id: payment.id }, data: { updatedAt: expiredAt } }),
  ]);
  return { category, user, reservationId: hold.reservationId, orderId: checkout.orderId, payment };
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

function configureChariPayReconciliation() {
  vi.stubEnv("CHARIPAY_ENV", "sandbox");
  vi.stubEnv("CHARIPAY_API_KEY", "chari_sk_test_checkout-reconciliation");
  vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "checkout-reconciliation-secret");
  vi.stubEnv("ONLYLIVE_PUBLIC_URL", "https://preview.onlylive.test");
  vi.stubEnv("VERCEL_ENV", "preview");
}

/**
 * claimNextExpiredCheckoutPayment() claims globally (oldest-due-first),
 * not scoped to any one test's own fixture — and this suite's shared,
 * non-isolated test database is never truncated between local runs. Every
 * test here backdates its fixture's updated_at to 2001, so a leftover row
 * from an earlier run/session can still be claimed ahead of the current
 * test's own fixture (same created_at ordering), non-deterministically
 * stealing reconcileExpiredCheckouts(1)'s single claim slot. Confirmed:
 * this produced exactly this file's two ledger-reconciliation tests'
 * symptoms (a stale FakeProvider payment silently closed instead of the
 * current ChariPay fixture being reconciled). Push every pre-existing
 * candidate outside the claim query's eligibility window before each test
 * — 2999, not deleted, so this never races a concurrent test run.
 */
async function quarantineExistingExpiredCheckoutCandidates(): Promise<void> {
  await prisma.$executeRaw`
    UPDATE payments p
    SET updated_at = TIMESTAMP '2999-01-01 00:00:00'
    FROM orders o
    WHERE p.order_id = o.id
      AND o.status = 'pending_payment'
      AND o.expires_at IS NOT NULL
      AND o.expires_at < (now() AT TIME ZONE 'UTC')
      AND p.status IN ('pending', 'awaiting_payment')
  `;
}

describe("expired hosted checkout reconciliation", () => {
  beforeEach(async () => {
    await quarantineExistingExpiredCheckoutCandidates();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("releases inventory only after the provider confirms the session is non-payable", async () => {
    const fixture = await setupExpiredCheckout();
    const closeSpy = vi.spyOn(FakeProvider.prototype, "closePaymentSession").mockResolvedValue({
      state: "non_payable",
      providerStatus: "EXPIRED",
    });

    await reconcileExpiredCheckouts(1);
    expect(closeSpy).toHaveBeenCalledWith(fixture.payment.providerPaymentId, `checkout-reconcile-${fixture.payment.id}`);

    const [reservation, order, payment, inventory] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } }),
    ]);
    expect(reservation.status).toBe("cancelled");
    expect(order.status).toBe("cancelled");
    expect(payment.status).toBe("cancelled");
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(0);
  });

  it("keeps inventory reserved and records attention when provider state is ambiguous", async () => {
    const fixture = await setupExpiredCheckout();
    const closeSpy = vi.spyOn(FakeProvider.prototype, "closePaymentSession").mockResolvedValue({
      state: "unknown",
      providerStatus: "SESSION_ALREADY_CONSUMED",
      correlationId: "corr-ambiguous",
    });

    await reconcileExpiredCheckouts(1);
    expect(closeSpy).toHaveBeenCalledWith(fixture.payment.providerPaymentId, `checkout-reconcile-${fixture.payment.id}`);

    const [reservation, order, payment, inventory, attention] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } }),
      prisma.auditLog.findFirst({
        where: {
          action: "payment.checkout_reconciliation_required",
          entityType: "Payment",
          entityId: fixture.payment.id,
        },
      }),
    ]);
    expect(reservation.status).toBe("active");
    expect(order.status).toBe("pending_payment");
    expect(payment.status).toBe("awaiting_payment");
    expect(inventory.reservedQuantity).toBe(1);
    expect(attention).not.toBeNull();
  });

  it("leases provider work so a concurrent worker cannot close the same checkout twice", async () => {
    const fixture = await setupExpiredCheckout();
    let resolveClose!: (value: { state: "unknown"; providerStatus: string }) => void;
    const closeSpy = vi.spyOn(FakeProvider.prototype, "closePaymentSession").mockImplementation(
      () => new Promise((resolve) => {
        resolveClose = resolve;
      }),
    );

    const firstWorker = reconcileExpiredCheckouts(1);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));

    const secondWorker = await reconcileExpiredCheckouts(1);
    expect(secondWorker).toMatchObject({ checked: 0, closed: 0, unresolved: 0, errors: 0 });
    expect(closeSpy).toHaveBeenCalledTimes(1);

    resolveClose({ state: "unknown", providerStatus: "SESSION_ALREADY_CONSUMED" });
    const firstResult = await firstWorker;
    expect(firstResult).toMatchObject({ checked: 1, closed: 0, unresolved: 1, errors: 0 });

    const payment = await prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } });
    expect(payment.status).toBe("awaiting_payment");
  });

  it("never releases inventory when a captured-payment webhook wins before local finalization", async () => {
    const fixture = await setupExpiredCheckout();
    let resolveClose!: (value: { state: "non_payable"; providerStatus: string }) => void;
    const closeSpy = vi.spyOn(FakeProvider.prototype, "closePaymentSession").mockImplementation(
      () => new Promise((resolve) => {
        resolveClose = resolve;
      }),
    );

    const reconciliation = reconcileExpiredCheckouts(1);
    await vi.waitFor(() => expect(closeSpy).toHaveBeenCalledTimes(1));

    const webhook = await fakeWebhookPost(fakeWebhookRequest({
      eventId: crypto.randomUUID(),
      providerPaymentId: fixture.payment.providerPaymentId,
      type: "payment.succeeded",
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
    }));
    expect(webhook.status).toBe(200);

    resolveClose({ state: "non_payable", providerStatus: "EXPIRED" });
    const result = await reconciliation;
    expect(result.closed).toBe(0);

    const [reservation, order, payment, inventory, tickets] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } }),
      prisma.ticket.count({ where: { eventId: fixture.category.eventId } }),
    ]);
    expect(reservation.status).toBe("converted");
    expect(order.status).toBe("paid");
    expect(payment.status).toBe("paid");
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(1);
    expect(tickets).toBe(1);
  });
  it("recovers a captured ChariPay payment from the authenticated transaction ledger before cancellation", async () => {
    const fixture = await setupExpiredCheckout();
    configureChariPayReconciliation();
    await prisma.payment.update({
      where: { id: fixture.payment.id },
      data: { provider: "charipay" },
    });

    const lookupSpy = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "succeeded",
      providerOperationId: "281",
      providerStatus: "SUCCESS",
    });
    const closeSpy = vi.spyOn(ChariPayProvider.prototype, "closePaymentSession");

    const result = await reconcileExpiredCheckouts(1);

    // Asserted before the result shape below: if the claim ever picks up a
    // stale candidate instead of this fixture (see
    // quarantineExistingExpiredCheckoutCandidates's doc comment), these
    // spy assertions fail with which payment/provider actually got called,
    // instead of just a generic { unresolved: 1 } mismatch.
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledWith({
      orderExternalId: fixture.orderId,
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
    });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, closed: 0, unresolved: 0, errors: 0 });

    const [reservation, order, payment, inventory, tickets, audit, email] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } }),
      prisma.ticket.count({ where: { eventId: fixture.category.eventId } }),
      prisma.auditLog.findFirst({
        where: {
          action: "payment.reconciled_from_provider_transaction",
          entityType: "Payment",
          entityId: fixture.payment.id,
        },
      }),
      prisma.emailOutbox.findFirst({
        where: {
          type: "order_confirmation",
          entityType: "order",
          entityId: fixture.orderId,
        },
      }),
    ]);

    expect(reservation.status).toBe("converted");
    expect(order.status).toBe("paid");
    expect(payment.status).toBe("paid");
    expect(inventory.reservedQuantity).toBe(0);
    expect(inventory.soldQuantity).toBe(1);
    expect(tickets).toBe(1);
    expect(audit).not.toBeNull();
    expect(email).not.toBeNull();
  });

  it("does not cancel a ChariPay checkout while the authenticated ledger is still pending", async () => {
    const fixture = await setupExpiredCheckout();
    configureChariPayReconciliation();
    await prisma.payment.update({
      where: { id: fixture.payment.id },
      data: { provider: "charipay" },
    });

    const lookupSpy = vi.spyOn(ChariPayProvider.prototype, "lookupPaymentStatus").mockResolvedValue({
      status: "pending",
      providerOperationId: "300",
      providerStatus: "PENDING_3DS",
    });
    const closeSpy = vi.spyOn(ChariPayProvider.prototype, "closePaymentSession");

    const result = await reconcileExpiredCheckouts(1);

    // Same reasoning as the "succeeded" test above: assert which payment
    // was actually looked up before the generic result-shape check.
    expect(lookupSpy).toHaveBeenCalledTimes(1);
    expect(lookupSpy).toHaveBeenCalledWith({
      orderExternalId: fixture.orderId,
      amountCents: fixture.payment.amountCents,
      currency: fixture.payment.currency,
    });
    expect(closeSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({ checked: 1, closed: 0, unresolved: 1, errors: 0 });

    const [reservation, order, payment, inventory] = await Promise.all([
      prisma.reservation.findUniqueOrThrow({ where: { id: fixture.reservationId } }),
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.payment.findUniqueOrThrow({ where: { id: fixture.payment.id } }),
      prisma.inventory.findUniqueOrThrow({ where: { ticketCategoryId: fixture.category.id } }),
    ]);

    expect(reservation.status).toBe("active");
    expect(order.status).toBe("pending_payment");
    expect(payment.status).toBe("awaiting_payment");
    expect(inventory.reservedQuantity).toBe(1);
    expect(inventory.soldQuantity).toBe(0);
  });

});
