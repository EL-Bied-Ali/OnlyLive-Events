import { NextRequest, NextResponse } from "next/server";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { isInternalRequestAuthorized } from "@/lib/http/internalAuth";

export const runtime = "nodejs";

/**
 * Invoked by a scheduled trigger (Vercel Cron or an external scheduler),
 * using the same dual X-Internal-Secret/CRON_SECRET authorization pattern as
 * sweep-expired-holds. Vercel Cron invokes configured paths with GET, while
 * POST remains available for an explicitly configured external scheduler.
 *
 * This stays separate from hold sweeping so a slow email batch never delays
 * the time-sensitive hold sweep, or vice versa. Correctness of the outbox
 * itself never depends on this running on any particular schedule — a
 * crashed/delayed run means pending emails wait longer, not that one is lost.
 *
 * The route is intentionally not wired into vercel.json on the current Hobby
 * plan: its once-daily scheduling precision is too infrequent for customer-
 * facing order-confirmation/failure emails. A higher-frequency external
 * scheduler (or a plan supporting the required cadence) must call this route.
 */
async function runDispatch(request: NextRequest) {
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

export const GET = runDispatch;
export const POST = runDispatch;
