import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { isInternalRequestAuthorized } from "@/lib/http/internalAuth";
import { pruneRateLimitBuckets } from "@/lib/rateLimit";
import { scheduleEagerEmailDispatch } from "@/lib/email/eagerDispatch";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external scheduler),
 * using the same dual X-Internal-Secret/CRON_SECRET authorization pattern as
 * dispatch-emails. Vercel Cron invokes configured paths with GET, while POST
 * remains available for an explicitly configured external scheduler. Purely
 * for UI-freshness of displayed availability — correctness never depends on
 * this running; see lib/inventory.ts's lazy release inside createHold.
 */
async function runSweep(request: NextRequest) {
  try {
    if (!isInternalRequestAuthorized(request)) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid internal credentials");
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

export const GET = runSweep;
export const POST = runSweep;
