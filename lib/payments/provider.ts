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
  /** Provider session should not remain payable after OnlyLive's checkout hold. */
  expiresAt?: Date;
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
  /** Provider payment/session id when the emitted event carries it. */
  providerPaymentId?: string;
  /** Provider refund id when the emitted event carries it. */
  providerRefundId?: string;
  /** Stable OnlyLive Payment id echoed by the provider. */
  paymentExternalId?: string;
  /** Stable OnlyLive Refund id/refundReference echoed by the provider. */
  refundExternalId?: string;
  type: PaymentWebhookEventType;
  /** Undefined means the provider payload did not prove this immutable fact. */
  amountCents?: number;
  /** Undefined means the provider payload did not prove this immutable fact. */
  currency?: string;
  signatureValid: boolean;
  /**
   * Provider-schema validation is deliberately separate from authentication.
   * A correctly signed but incomplete/unrecognized payload must never mutate
   * money or ticket state.
   */
  payloadValid: boolean;
  raw: unknown;
}

export interface RefundInput {
  providerPaymentId: string;
  paymentExternalId: string;
  amountCents: number;
  currency: string;
  reason: string;
  /** Stable OnlyLive Refund id; also used as ChariPay refundReference. */
  idempotencyKey: string;
}

export interface RefundResult {
  providerRefundId: string | null;
  state: "processing" | "succeeded";
}

export interface RefundStatusResult {
  providerRefundId: string | null;
  status: "pending" | "succeeded" | "failed" | "not_found";
}

/**
 * Providers can explicitly reject a request (safe to retry later with a new
 * business attempt) or leave the caller uncertain whether it was accepted
 * (network drop / retryable HTTP response after receipt). Money-moving code
 * must distinguish the two: an unknown refund outcome keeps the original
 * idempotency reference reserved and is reconciled/replayed with that same
 * reference rather than submitting a new refund.
 */
export class ProviderRequestError extends Error {
  constructor(
    message: string,
    public readonly outcomeUnknown: boolean,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "ProviderRequestError";
  }
}

export interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
  /** Query an already-submitted refund by its stable provider/reference id. */
  getRefundStatus(refundReference: string): Promise<RefundStatusResult>;
}
