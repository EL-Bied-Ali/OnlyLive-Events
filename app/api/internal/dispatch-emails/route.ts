import { NextRequest, NextResponse } from "next/server";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { isInternalRequestAuthorized } from "@/lib/http/internalAuth";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external cron hitting
 * this route), same dual X-Internal-Secret/CRON_SECRET pattern as
 * sweep-expired-holds — a separate endpoint rather than folded into that
 * one so a slow email batch never delays the time-sensitive hold sweep, or
 * vice versa. Correctness of the outbox itself never depends on this
 * running on any particular schedule — a crashed/delayed run just means
 * pending emails wait longer, never that one is lost or sent twice (see
 * lib/email/dispatcher.ts's atomic claim + lease reclaim). Not wired into
 * vercel.json's cron: on the current Vercel Hobby plan, native cron is
 * limited to once per day, which is far too infrequent for customer-facing
 * order-confirmation/failure emails — a higher-frequency external scheduler
 * (or a paid Vercel plan) must call this route directly until then.
 */
export async function POST(request: NextRequest) {
  try {
    if (!isInternalRequestAuthorized(request)) {
      throw new ApiError(401, "UNAUTHENTICATED", "Invalid internal credentials");
    }

    const summary = await dispatchPendingEmails();
    return NextResponse.json(summary);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
