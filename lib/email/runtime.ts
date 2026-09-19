/**
 * RESEND_TEST_RECIPIENT intentionally redirects every transactional email to
 * one inbox. That is useful for domainless sandbox testing, but catastrophic
 * for real traffic if enabled accidentally. On Vercel it is therefore allowed
 * only on the standard Preview target, not Production or a custom environment.
 * Outside Vercel it is allowed only in explicit development/test Node
 * runtimes; unknown or missing runtime markers fail closed.
 */
export function isResendTestRecipientAllowed(): boolean {
  const vercelEnv = process.env.VERCEL_ENV?.trim();
  if (vercelEnv) {
    if (vercelEnv !== "preview") return false;

    const targetEnv = process.env.VERCEL_TARGET_ENV?.trim();
    return !targetEnv || targetEnv === "preview";
  }

  const nodeEnv = process.env.NODE_ENV?.trim();
  return nodeEnv === "development" || nodeEnv === "test";
}
