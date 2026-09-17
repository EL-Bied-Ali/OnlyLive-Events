import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { isInternalRequestAuthorized } from "@/lib/http/internalAuth";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
import { reconcileExpiredCheckouts } from "@/lib/orders/checkoutReconciliation";
import { reconcileProcessingRefundsFair } from "@/lib/orders/refundReconciliation";

export const runtime = "nodejs";

async function runHousekeeping(request: NextRequest) {
  try {
    if (!isInternalRequestAuthorized(request)) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid housekeeping credentials");
    }

    // Purely local cleanup can run in parallel. Provider reconciliation is
    // intentionally sequenced and bounded so the fallback cannot consume the
    // whole ChariPay API budget during a checkout spike.
    const [holds, rateLimits] = await Promise.all([
      sweepExpiredHolds(),
      pruneRateLimitBuckets(),
    ]);
    const checkouts = await reconcileExpiredCheckouts(5);
    const refunds = await reconcileProcessingRefundsFair(10);

    return NextResponse.json({
      ...holds,
      rateLimitBucketsDeleted: rateLimits.deleted,
      checkoutReconciliation: checkouts,
      refundReconciliation: refunds,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Vercel Cron invokes GET and sends CRON_SECRET as Authorization: Bearer.
 * POST remains available for an explicitly configured external scheduler via
 * X-Internal-Secret. Provider reconciliation is a correctness fallback for
 * lost/ambiguous async outcomes; pre-checkout hold expiry also has lazy release.
 */
export const GET = runHousekeeping;
export const POST = runHousekeeping;
