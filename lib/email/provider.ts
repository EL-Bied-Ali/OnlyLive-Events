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
}

export interface SendEmailResult {
  providerMessageId: string;
}


export class EmailProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
    public readonly status?: number,
    public readonly providerCode?: string,
  ) {
    super(message);
    this.name = "EmailProviderError";
  }
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
