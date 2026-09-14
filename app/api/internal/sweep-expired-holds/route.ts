import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
import { reconcileProcessingRefunds } from "@/lib/orders/refund";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external cron hitting
 * this route) roughly every minute. Hold correctness never depends on this
 * running (createHold releases lazily), while refund reconciliation uses it
 * as a fallback when a provider webhook or refund POST response is lost.
 */
export async function POST(request: NextRequest) {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    const provided = request.headers.get("x-internal-secret");
    if (!secret || provided !== secret) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid internal secret");
    }

    const [holds, rateLimits, refunds] = await Promise.all([
      sweepExpiredHolds(),
      pruneRateLimitBuckets(),
      reconcileProcessingRefunds(),
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
