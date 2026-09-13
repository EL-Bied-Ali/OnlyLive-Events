import { NextRequest, NextResponse } from "next/server";
import { sweepExpiredHolds } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";

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

    const result = await sweepExpiredHolds();
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
