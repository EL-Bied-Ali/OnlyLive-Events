import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
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

    const [holds, rateLimits, refunds] = await Promise.all([
      sweepExpiredHolds(),
      pruneRateLimitBuckets(),
      reconcileProcessingRefundsFair(),
    ]);
    return NextResponse.json({
      ...holds,
      rateLimitBucketsDeleted: rateLimits.deleted,
      refundReconciliation: refunds,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}

/**
 * Vercel Cron invokes GET and sends CRON_SECRET as Authorization: Bearer.
 * POST remains available for an explicitly configured external scheduler via
 * X-Internal-Secret. Refund reconciliation is correctness fallback for lost
 * webhooks/ambiguous refund submissions; hold expiry also has lazy release.
 */
export const GET = runHousekeeping;
export const POST = runHousekeeping;
