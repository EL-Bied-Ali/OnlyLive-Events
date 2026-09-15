import { NextRequest, NextResponse } from "next/server";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external cron hitting
 * this route), same X-Internal-Secret pattern as sweep-expired-holds — a
 * separate endpoint rather than folded into that one so a slow email
 * batch never delays the time-sensitive hold sweep, or vice versa.
 * Correctness of the outbox itself never depends on this running on any
 * particular schedule — a crashed/delayed run just means pending emails
 * wait longer, never that one is lost or sent twice (see
 * lib/email/dispatcher.ts's atomic claim + lease reclaim).
 */
export async function POST(request: NextRequest) {
  try {
    const secret = process.env.INTERNAL_API_SECRET;
    const provided = request.headers.get("x-internal-secret");
    if (!secret || provided !== secret) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid internal secret");
    }

    const summary = await dispatchPendingEmails();
    return NextResponse.json(summary);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
