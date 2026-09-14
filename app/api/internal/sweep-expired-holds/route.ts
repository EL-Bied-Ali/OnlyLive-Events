import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
import { reconcileProcessingRefunds } from "@/lib/orders/refund";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external cron hitting
 * this route) roughly every minute. Hold correctness never depends on this
 * running because createHold also lazily expires reservations. Refund
 * reconciliation uses it as a webhook-loss fallback: provider callbacks are
 * still the normal low-latency path, while old processing refunds are polled
 * in a bounded batch so money state cannot remain unknown indefinitely.
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
      refunds,
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
