/**
 * Not inline in the route handler: app/api/pay/fake/[paymentId]/simulate
 * is a Next.js Route Handler file, which only expects HTTP-method and
 * segment-config exports — a business-logic helper belongs in its own
 * module regardless, and keeping it here also makes its one conditional
 * branch unit-testable without a real customer session or a real Vercel
 * deployment. Actually bypassing Vercel's Deployment Protection can only
 * be verified against the real platform, but whether our own code
 * attaches the header correctly can and should be tested in isolation.
 */
export function buildFakeWebhookForwardHeaders(signature: string, bypassSecret: string | undefined) {
  return {
    "content-type": "application/json",
    "x-onlylive-fake-signature": signature,
    // Vercel's Deployment Protection sits in front of every URL on a
    // project without a connected custom domain, including this
    // server-to-server self-call — without this header it never
    // reaches the webhook route at all (401 from Vercel, not from
    // our own auth). Only set when the project has "Protection
    // Bypass for Automation" configured; a no-op otherwise, matching
    // unprotected local/CI/custom-domain environments.
    ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
  };
}
