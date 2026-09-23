import "server-only";
import { after } from "next/server";
import { dispatchPendingEmails } from "@/lib/email/dispatcher";

/**
 * Schedules a best-effort attempt to drain the EmailOutbox right after the
 * current request's response has already been sent, so a customer sees their
 * confirmation email arrive within seconds of a successful purchase instead
 * of waiting for the next periodic dispatch-emails run.
 *
 * This is a latency optimization only, never a correctness guarantee:
 * - `after()` throws synchronously when called outside a real Next.js
 *   request/Server Action scope (e.g. every existing webhook test, which
 *   invokes a route's exported handler directly rather than through a real
 *   server). That throw is swallowed here rather than propagated, so calling
 *   this from anywhere always leaves the caller's own response unaffected.
 * - If the scheduled callback itself throws (a total dispatcher-level
 *   failure, not a per-email one — dispatchPendingEmails() already catches
 *   and records ordinary per-row failures internally), it is caught and
 *   logged, never rethrown into `after()`'s own error handling.
 * - A crash between this call and `after()` actually running, or between an
 *   outbox row's creation and this call, is exactly the recovery case the
 *   periodic dispatch-emails endpoint exists for. Call sites must never skip
 *   wiring that periodic trigger on the assumption this makes it redundant.
 *
 * Safe to call unconditionally even when the caller isn't sure a new outbox
 * row was actually created this request: dispatchPendingEmails() against an
 * empty backlog is a fast no-op.
 */
export function scheduleEagerEmailDispatch(): void {
  try {
    // Returns the promise (rather than a void block body) so the platform
    // can wait for it to settle before considering deferred work done,
    // instead of racing ahead and potentially cutting it off early.
    after(() =>
      dispatchPendingEmails().catch(() => {
        // A total dispatcher-level failure (e.g. a DB connection issue), not
        // an ordinary per-row send failure -- dispatchPendingEmails() already
        // catches and records those internally with its own safe error
        // codes. Never log the raw exception here: per the same privacy
        // rule dispatcher.ts's errorCode() documents, an arbitrary
        // exception message can carry SQL details, URLs, or customer data.
        console.error("[email:eager-dispatch] failed error=eager_dispatch_internal_error");
      }),
    );
  } catch {
    // Outside a real request scope — nothing to do; see the doc comment above.
  }
}
