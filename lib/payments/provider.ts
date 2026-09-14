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
  /** Provider callback endpoint. Required by the ChariPay adapter. */
  webhookUrl?: string;
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
  externalEventId: string;
  providerPaymentId: string;
  paymentExternalId?: string;
  refundExternalId?: string;
  type: PaymentWebhookEventType;
  amountCents: number;
  currency: string;
  signatureValid: boolean;
  raw: unknown;
}

export interface RefundInput {
  providerPaymentId: string;
  paymentExternalId: string;
  amountCents: number;
  reason: string;
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string | null;
  state: "processing" | "succeeded";
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
