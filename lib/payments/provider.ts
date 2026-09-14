/**
 * No Moroccan PSP has been selected yet. Every payment interaction goes
 * through this interface so that swapping FakeProvider for a real adapter
 * later (implemented from that PSP's official docs) touches nothing else
 * in the app. See docs/PAYMENTS.md.
 */
export interface CreatePaymentInput {
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  customerEmail: string;
  returnUrl: string;
}

export interface CreatePaymentResult {
  redirectUrl: string;
  providerPaymentId: string;
}

export interface ParseWebhookInput {
  rawBody: string;
  headers: Record<string, string>;
}

export type PaymentWebhookEventType =
  | "payment.succeeded"
  | "payment.failed"
  | "payment.cancelled"
  | "refund.succeeded";

export interface ParsedWebhookEvent {
  externalEventId: string;
  providerPaymentId: string;
  type: PaymentWebhookEventType;
  amountCents: number;
  currency: string;
  signatureValid: boolean;
  raw: unknown;
}

export interface RefundInput {
  providerPaymentId: string;
  amountCents: number;
  reason: string;
  /**
   * Stable per-refund-attempt key (the Refund row's id). FakeProvider
   * ignores it since its refund() is a synchronous local operation with
   * no real network call, but a real adapter must pass it through to the
   * PSP so a retried refund request can never charge/refund twice.
   */
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string;
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
