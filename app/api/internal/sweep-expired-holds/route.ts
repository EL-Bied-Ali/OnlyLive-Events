import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
import { reconcileExpiredCheckouts } from "@/lib/orders/checkoutReconciliation";
import { reconcileProcessingRefundsFair } from "@/lib/orders/refundReconciliation";

export const runtime = "nodejs";

function isAuthorized(request: NextRequest): boolean {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const internalHeader = request.headers.get("x-internal-secret");
  const authorization = request.headers.get("authorization");
  return Boolean(
    (internalSecret && internalHeader === internalSecret)
    || (cronSecret && authorization === `Bearer ${cronSecret}`),
  );
}

async function runHousekeeping(request: NextRequest) {
  try {
    if (!isAuthorized(request)) {
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
