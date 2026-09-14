/**
 * Every payment interaction goes through this interface. The fake provider
 * exercises the same lifecycle as the real hosted-checkout provider, while
 * provider-specific authentication/signature details stay in the adapter.
 */
export interface CreatePaymentInput {
  /** Stable OnlyLive Payment id; real providers may use this as externalId. */
  paymentId: string;
  orderId: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  customerEmail: string;
  /** Browser return destination. A redirect is never proof of payment. */
  returnUrl: string;
  /** Provider callback endpoint. Must be public HTTPS for ChariPay. */
  webhookUrl: string;
}

export interface CreatePaymentResult {
  redirectUrl: string;
  /** Provider reference stored on Payment for support/reconciliation. */
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
  | "refund.succeeded"
  | "refund.failed";

export interface ParsedWebhookEvent {
  /** Stable provider event id used for webhook deduplication. */
  externalEventId: string;
  /** Provider payment/session reference when the event is payment-scoped. */
  providerPaymentId: string;
  /** Stable OnlyLive Payment id echoed through provider externalId/metadata when available. */
  paymentExternalId?: string;
  /** Stable OnlyLive Refund id echoed through refundReference when refund-scoped. */
  refundExternalId?: string;
  type: PaymentWebhookEventType;
  amountCents: number;
  currency: string;
  signatureValid: boolean;
  raw: unknown;
}

export interface RefundInput {
  providerPaymentId: string;
  /** Stable OnlyLive Payment id used as ChariPay's payment externalId. */
  paymentExternalId: string;
  amountCents: number;
  reason: string;
  /** Stable refund reference. Replaying it must never create a second refund. */
  idempotencyKey: string;
}

export interface RefundResult {
  /** Provider refund id/reference when returned by the provider. */
  providerRefundId: string | null;
  /**
   * `succeeded` is used by the local FakeProvider. Real ChariPay refunds are
   * asynchronous and return `processing`; final state arrives by webhook.
   */
  state: "processing" | "succeeded";
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
