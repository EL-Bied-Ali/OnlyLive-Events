/**
 * Next.js calls `register()` once when the server starts, before any
 * request is handled — in dev and in production. Used here purely for
 * fail-fast config validation: if PAYMENT_PROVIDER=fake is configured in
 * production without the explicit ALLOW_FAKE_PAYMENTS_IN_PRODUCTION
 * opt-in, getPaymentProvider() throws, and that throw crashes startup
 * instead of only surfacing on the first webhook call.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getPaymentProvider } = await import("@/lib/payments");
    getPaymentProvider();
  }
}
