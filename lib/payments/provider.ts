/**
 * Payment-provider boundary. Provider-specific HTTP shapes stay behind this
 * interface; the rest of the application only deals in integer cents and
 * OnlyLive-owned identifiers. See docs/PAYMENTS.md.
 */
export interface CreatePaymentInput {
  /** Stable OnlyLive Payment.id. Safe to expose to a PSP as externalId. */
  paymentId: string;
  /** Internal order id, retained for existing providers/tests. */
  orderId: string;
  /** Human/business order reference when the PSP supports one. */
  orderNumber?: string;
  amountCents: number;
  currency: string;
  idempotencyKey: string;
  customerEmail: string;
  /** Browser return URL. It is never authoritative for payment state. */
  returnUrl: string;
  /** Optional provider-specific failure/cancel return. */
  declineUrl?: string;
  /** Optional provider webhook target for per-payment/session callbacks. */
  notificationUrl?: string;
  /** Optional provider-session expiry. */
  expiresAt?: Date;
}

export interface CreatePaymentResult {
  redirectUrl: string;
  /** Provider-side session/payment reference useful for support/debugging. */
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
  /** Provider event id used for delivery deduplication. */
  externalEventId: string;
  /** Provider-side payment/operation reference when supplied by the event. */
  providerPaymentId?: string;
  /**
   * Stable OnlyLive Payment.id previously sent to the PSP as externalId.
   * Real providers should prefer this for reconciliation when supported.
   */
  paymentExternalId?: string;
  /** Stable OnlyLive Refund.id when this is a refund event. */
  refundReference?: string;
  type: PaymentWebhookEventType;
  /** Amount actually reported by the provider, in OnlyLive integer cents. */
  amountCents: number;
  currency: string;
  signatureValid: boolean;
  raw: unknown;
}

export interface RefundInput {
  /** Stable OnlyLive Payment.id; ChariPay uses this as externalId. */
  paymentExternalId: string;
  /** Provider-side reference retained for providers that require it. */
  providerPaymentId: string;
  amountCents: number;
  currency: string;
  reason: string;
  /**
   * Stable per-refund-attempt key (the Refund row id). A real provider must
   * pass this through as its idempotency/refund reference so a retry can
   * never create a second refund.
   */
  idempotencyKey: string;
}

export interface RefundResult {
  /** Stable reference used to reconcile future provider callbacks/status. */
  providerRefundId: string;
  /** Some PSPs settle asynchronously; do not mark business state refunded until succeeded. */
  status: "pending" | "succeeded";
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
