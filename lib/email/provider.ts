/**
 * Provider-neutral transactional email contract. Resend is the first real
 * adapter; console remains the local/test implementation. Business code and
 * the durable outbox depend only on this interface.
 */
export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /**
   * Stable per-outbox-row key (the EmailOutbox row's id). ConsoleEmailProvider
   * ignores it; real adapters forward it to their provider's idempotency
   * mechanism. Provider retention windows still matter operationally — this
   * is defense against normal retries, not a claim of infinite exactly-once
   * delivery.
   */
  idempotencyKey: string;
  /**
   * True for mail carrying a bearer-like secret (e.g. a password-reset
   * link). A real provider still receives and delivers the full body —
   * this only tells ConsoleEmailProvider not to print to/subject/text,
   * since Preview deployments allow that provider and its output lands in
   * runtime logs.
   */
  sensitive?: boolean;
}

export interface SendEmailResult {
  providerMessageId: string;
}


const SAFE_EMAIL_PROVIDER_ERROR_CODE = /^[a-z0-9_]{1,100}$/i;

export class EmailProviderError extends Error {
  readonly safeCode: string;
  readonly providerCode?: string;

  constructor(
    code: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    providerCode?: string,
  ) {
    // Provider adapters must expose only small machine codes. If a future
    // adapter accidentally passes a raw response body/message here, fail
    // privacy-safe instead of retaining text that a later caller could log.
    const safeCode = SAFE_EMAIL_PROVIDER_ERROR_CODE.test(code) ? code : "email_provider_error";
    super(safeCode);
    this.safeCode = safeCode;
    this.providerCode = providerCode && SAFE_EMAIL_PROVIDER_ERROR_CODE.test(providerCode) ? providerCode : undefined;
    this.name = "EmailProviderError";
  }
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
