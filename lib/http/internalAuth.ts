import "server-only";
import type { NextRequest } from "next/server";

/**
 * Shared authorization check for internal housekeeping/scheduler endpoints
 * (sweep-expired-holds, dispatch-emails): accepts either an explicitly
 * configured X-Internal-Secret (manual/external callers) or Vercel Cron's
 * own Authorization: Bearer <CRON_SECRET> header, so any route using this
 * can be wired into vercel.json's native cron without a separate auth path.
 */
export function isInternalRequestAuthorized(request: NextRequest): boolean {
  const internalSecret = process.env.INTERNAL_API_SECRET;
  const cronSecret = process.env.CRON_SECRET;
  const internalHeader = request.headers.get("x-internal-secret");
  const authorization = request.headers.get("authorization");
  return Boolean(
    (internalSecret && internalHeader === internalSecret)
    || (cronSecret && authorization === `Bearer ${cronSecret}`),
  );
}
