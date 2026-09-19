import { EmailProviderError, type EmailProvider, type SendEmailInput, type SendEmailResult } from "@/lib/email/provider";

const RESEND_API_URL = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10_000;

function requiredEnv(name: "RESEND_API_KEY" | "RESEND_FROM_EMAIL"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`EMAIL_PROVIDER=resend requires ${name}`);
  return value;
}

function plainEmail(value: string, name: string): string {
  if (/[\r\n]/.test(value) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new Error(`${name} must be a plain email address`);
  }
  return value;
}

function resendFromEmail(): string {
  return plainEmail(requiredEnv("RESEND_FROM_EMAIL"), "RESEND_FROM_EMAIL");
}

function resendTestRecipient(): string | undefined {
  const value = process.env.RESEND_TEST_RECIPIENT?.trim();
  if (!value) return undefined;

  if (process.env.VERCEL_ENV === "production") {
    throw new Error("RESEND_TEST_RECIPIENT is forbidden in Vercel Production");
  }

  return plainEmail(value, "RESEND_TEST_RECIPIENT");
}

function safeProviderCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as { name?: unknown }).name;
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/i.test(value) ? value : undefined;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  constructor() {
    // instrumentation.ts calls getEmailProvider() at boot, so construction
    // intentionally validates production configuration before any request.
    requiredEnv("RESEND_API_KEY");
    const from = resendFromEmail();
    const testRecipient = resendTestRecipient();

    if (from.endsWith("@resend.dev") && !testRecipient) {
      throw new Error("A resend.dev test sender requires RESEND_TEST_RECIPIENT");
    }
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    if (!input.idempotencyKey || input.idempotencyKey.length > 256) {
      throw new EmailProviderError("resend_invalid_idempotency_key", false, 400, "invalid_idempotency_key");
    }

    const testRecipient = resendTestRecipient();
    const recipient = testRecipient ?? input.to;
    const providerIdempotencyKey = testRecipient ? `test-${input.idempotencyKey}` : input.idempotencyKey;
    if (providerIdempotencyKey.length > 256) {
      throw new EmailProviderError("resend_invalid_idempotency_key", false, 400, "invalid_idempotency_key");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(RESEND_API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${requiredEnv("RESEND_API_KEY")}`,
          "Content-Type": "application/json",
          "Idempotency-Key": providerIdempotencyKey,
        },
        body: JSON.stringify({
          from: `OnlyLive <${resendFromEmail()}>`,
          to: [recipient],
          subject: input.subject,
          text: input.text,
        }),
      });
    } catch {
      throw new EmailProviderError("resend_request_failed", true);
    } finally {
      clearTimeout(timer);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      if (response.ok) {
        throw new EmailProviderError("resend_malformed_success_response", true, response.status, "malformed_success_response");
      }
      body = undefined;
    }

    if (!response.ok) {
      const code = safeProviderCode(body);
      const retryable =
        response.status === 401
        || response.status === 403
        || response.status === 408
        || response.status === 429
        || response.status >= 500
        || code === "concurrent_idempotent_requests";
      throw new EmailProviderError(code ? `resend_${code}` : `resend_http_${response.status}`, retryable, response.status, code);
    }

    const id =
      body && typeof body === "object" && !Array.isArray(body)
        ? (body as { id?: unknown }).id
        : undefined;
    if (typeof id !== "string" || id.length === 0 || id.length > 256) {
      // The provider may have accepted the email, so this is an ambiguous
      // outcome and must remain retryable under the same idempotency key.
      throw new EmailProviderError("resend_missing_message_id", true, response.status, "missing_message_id");
    }

    return { providerMessageId: id };
  }
}
