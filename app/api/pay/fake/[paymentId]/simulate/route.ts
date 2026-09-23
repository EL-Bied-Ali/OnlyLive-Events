import crypto from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { absoluteAppUrl } from "@/lib/appUrl";
import { requireCustomer } from "@/lib/auth/customer";
import { getPaymentForFakeCheckoutPage } from "@/lib/orders/checkout";
import { signFakeWebhookPayload } from "@/lib/payments/fakeProvider";
import { isFakePaymentsAllowed } from "@/lib/payments";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";

export const runtime = "nodejs";

const bodySchema = z.object({
  outcome: z.enum(["succeeded", "failed", "cancelled"]),
});

const OUTCOME_TO_EVENT_TYPE = {
  succeeded: "payment.succeeded",
  failed: "payment.failed",
  cancelled: "payment.cancelled",
} as const;

/**
 * Stands in for "the customer completed (or abandoned) the PSP's hosted
 * checkout page". Requires the requesting customer to own the order —
 * this is a dev/sandbox convenience gate, not a substitute for the real
 * webhook's own signature verification, which happens regardless of who
 * calls this route.
 */
export async function POST(request: NextRequest, context: { params: Promise<{ paymentId: string }> }) {
  try {
    if (!isFakePaymentsAllowed()) {
      throw new ApiError(404, "NOT_FOUND", "Not found");
    }

    const customer = await requireCustomer();
    const { paymentId } = await context.params;

    const payment = await getPaymentForFakeCheckoutPage(paymentId);
    if (payment.order.userId !== customer.id) {
      throw new ApiError(404, "PAYMENT_NOT_FOUND", "Payment not found");
    }
    if (!payment.providerPaymentId) {
      throw new ApiError(409, "PAYMENT_NOT_READY", "Payment was not initialized correctly");
    }

    const body = await request.json();
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    const payload = JSON.stringify({
      eventId: crypto.randomUUID(),
      providerPaymentId: payment.providerPaymentId,
      type: OUTCOME_TO_EVENT_TYPE[parsed.data.outcome],
      amountCents: payment.amountCents,
      currency: payment.currency,
    });
    const signature = signFakeWebhookPayload(payload);

    const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
    // Resolved from NEXTAUTH_URL (lib/appUrl.ts), never from the
    // incoming request's own URL/Host — this call now carries a secret
    // header when bypassSecret is set, so the target must not be
    // influenceable by request data.
    const webhookResponse = await fetch(absoluteAppUrl("/api/payments/webhook/fake"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-onlylive-fake-signature": signature,
        // Vercel's Deployment Protection sits in front of every URL on a
        // project without a connected custom domain, including this
        // server-to-server self-call — without this header it never
        // reaches the webhook route at all (401 from Vercel, not from
        // our own auth). Only set when the project has "Protection
        // Bypass for Automation" configured; a no-op otherwise, matching
        // unprotected local/CI/custom-domain environments.
        ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
      },
      body: payload,
    });
    const webhookResult = await webhookResponse.json();

    return NextResponse.json({ orderId: payment.orderId, webhook: webhookResult }, { status: webhookResponse.status });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
