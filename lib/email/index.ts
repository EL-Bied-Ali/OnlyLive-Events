import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import { ResendEmailProvider } from "@/lib/email/resendProvider";
import type { EmailProvider } from "@/lib/email/provider";

/**
 * The sandbox console provider must be impossible to enable accidentally
 * in production — it never sends a real email, so a production deployment
 * silently defaulting to it would mean no customer ever receives a
 * confirmation/failure/refund email while the app believes delivery is
 * working. Same shape as lib/payments/index.ts::isFakePaymentsAllowed():
 * blocked whenever NODE_ENV === "production" unless explicitly opted into
 * for a genuinely non-production-traffic deployment (e.g. the Playwright
 * e2e suite's next start run) — never for real customer traffic.
 */
export function isConsoleEmailAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") {
    return true;
  }
  return process.env.ALLOW_CONSOLE_EMAIL_IN_PRODUCTION === "true";
}

/**
 * RESEND_TEST_RECIPIENT intentionally redirects every transactional email to
 * one inbox. That is useful for domainless sandbox testing, but catastrophic
 * for real traffic if enabled accidentally. On Vercel it is therefore allowed
 * only on Preview deployments. Outside Vercel it is allowed only in explicit
 * development/test Node runtimes; unknown or missing runtime markers fail
 * closed.
 */
export function isResendTestRecipientAllowed(): boolean {
  const vercelEnv = process.env.VERCEL_ENV?.trim();
  if (vercelEnv) {
    return vercelEnv === "preview";
  }

  const nodeEnv = process.env.NODE_ENV?.trim();
  return nodeEnv === "development" || nodeEnv === "test";
}

export function getEmailProvider(): EmailProvider {
  const provider = process.env.EMAIL_PROVIDER?.trim() || "console";

  if (provider === "console" && !isConsoleEmailAllowed()) {
    throw new Error(
      'EMAIL_PROVIDER=console cannot be used in production. Configure a real EmailProvider, or set ALLOW_CONSOLE_EMAIL_IN_PRODUCTION=true only for a deliberate non-production-traffic deployment — never for real customer traffic.',
    );
  }

  if (provider === "resend") {
    const testRecipient = process.env.RESEND_TEST_RECIPIENT?.trim();

    if (testRecipient && !isResendTestRecipientAllowed()) {
      throw new Error(
        "RESEND_TEST_RECIPIENT is only allowed on Vercel Preview or in an explicit local development/test runtime",
      );
    }

    const from = process.env.RESEND_FROM_EMAIL?.trim().toLowerCase();
    if (from?.endsWith("@resend.dev") && !testRecipient) {
      throw new Error("A resend.dev test sender requires RESEND_TEST_RECIPIENT");
    }
  }

  switch (provider) {
    case "console":
      return new ConsoleEmailProvider();
    case "resend":
      return new ResendEmailProvider();
    default:
      throw new Error(`Unknown EMAIL_PROVIDER: ${provider}. Supported providers: "console", "resend".`);
  }
}
