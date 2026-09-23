import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
import { scheduleEagerEmailDispatch } from "@/lib/email/eagerDispatch";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external cron hitting
 * this route) roughly every minute. Purely for UI-freshness of displayed
 * availability — correctness never depends on this running; see
 * lib/inventory.ts's lazy release inside createHold.
 */
export async function POST(request: NextRequest) {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    const provided = request.headers.get("x-internal-secret");
    if (!secret || provided !== secret) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid internal secret");
    }

    const [holds, rateLimits] = await Promise.all([sweepExpiredHolds(), pruneRateLimitBuckets()]);
    // Runs after this response is sent (see eagerDispatch.ts) — an extra
    // backstop trigger point alongside the dedicated dispatch-emails cron,
    // never delays this route's own time-sensitive work.
    scheduleEagerEmailDispatch();
    return NextResponse.json({ ...holds, rateLimitBucketsDeleted: rateLimits.deleted });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
