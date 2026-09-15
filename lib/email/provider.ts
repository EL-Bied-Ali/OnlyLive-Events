/**
 * No transactional email provider has been selected yet — same rule as
 * lib/payments: never build against a real provider's API speculatively.
 * When one is chosen, its adapter is implemented from that provider's
 * official docs and registered in lib/email/index.ts::getEmailProvider();
 * nothing else in the app should need to change.
 */
export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  /**
   * Stable per-outbox-row key (the EmailOutbox row's id). ConsoleEmailProvider
   * ignores it since it never makes a real network call, but a real adapter
   * must forward it to the provider so a retried dispatch attempt (same
   * outbox row, a later nextAttemptAt) can never send the same email twice
   * at the provider's own layer, mirroring RefundInput.idempotencyKey.
   */
  idempotencyKey: string;
}

export interface SendEmailResult {
  providerMessageId: string;
}

export interface EmailProvider {
  readonly name: string;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
