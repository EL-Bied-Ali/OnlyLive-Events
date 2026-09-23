import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/customer";
import { reconcileOrderPaymentOnDemand } from "@/lib/orders/paymentReconciliation";
import { buildRateLimitKey, consumeRateLimit, rateLimitHeaders } from "@/lib/rateLimit";
import { scheduleEagerEmailDispatch } from "@/lib/email/eagerDispatch";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

/**
 * Minimum spacing enforced between two accepted reconciliation attempts for
 * the same order. The customer page polls roughly every 5 seconds; this
 * stays under that so normal polling is never rejected, while a client
 * bypassing the intended interval (or several tabs open on the same order)
 * cannot turn every request into a ChariPay ledger lookup. Backed by the
 * same Postgres-backed fixed-window bucket already used for login/
 * registration throttling (lib/rateLimit.ts) — durable and correct across
 * concurrent Vercel instances, unlike an in-memory counter, and needs no
 * schema change of its own.
 */
const RECONCILE_RATE_LIMIT = { limit: 1, windowMs: 4_000 };

/**
 * Lets the customer order page ask OnlyLive to check ChariPay's authenticated
 * transaction ledger for a payment that is still `pending_payment` locally,
 * so a delayed webhook does not make the customer wait longer than necessary
 * to see their ticket. Never calls the provider directly from the browser
 * and never returns provider credentials or raw ledger data — only the
 * order's own status. All actual state mutation (if any) happens through the
 * exact same fulfillment path a verified webhook uses; see
 * lib/orders/paymentReconciliation.ts.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  try {
    const customer = await requireCustomer();
    const { orderId } = await context.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      select: { id: true, userId: true, status: true },
    });

    // Ownership mismatch and "doesn't exist" return the identical 404 —
    // never confirm another customer's order exists (IDOR hardening),
    // matching GET /api/orders/[orderId].
    if (!order || order.userId !== customer.id) {
      return NextResponse.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
    }

    // Skip the rate limit entirely for orders that have nothing left to
    // reconcile — a terminal order polled after the fact should never be
    // able to exhaust the same bucket a genuinely pending order needs.
    if (order.status !== "pending_payment") {
      return NextResponse.json({ status: order.status, reconciled: false });
    }

    const rateLimit = await consumeRateLimit(
      buildRateLimitKey("order-payment-reconcile", orderId),
      RECONCILE_RATE_LIMIT,
    );
    if (!rateLimit.allowed) {
      return NextResponse.json(
        { status: order.status, reconciled: false, throttled: true },
        { status: 429, headers: rateLimitHeaders(rateLimit) },
      );
    }

    const result = await reconcileOrderPaymentOnDemand(orderId);
    // Gated: this endpoint is polled roughly every 5s while a checkout is
    // pending, and `reconciled: false` (nothing actually changed, no
    // outbox row created) is the overwhelmingly common result. Scheduling
    // a global dispatch scan on every such poll would turn ordinary
    // customer polling into repeated unnecessary background work.
    if (result.reconciled) scheduleEagerEmailDispatch();
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
