/**
 * Next.js calls `register()` once when the server starts, before any
 * request is handled — in dev and in production. Used here purely for
 * fail-fast config validation so unsafe payment or rate-limit settings
 * crash startup instead of surfacing on the first customer request.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getPaymentProvider } = await import("@/lib/payments");
    const { assertRateLimitingConfig } = await import("@/lib/rateLimit");
    getPaymentProvider();
    assertRateLimitingConfig();
  }
}
