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
  /** Generic customer identity. Provider adapters decide what they require. */
  customerName?: string | null;
  customerPhone?: string | null;
  /** Browser return destination. A redirect is never proof of payment. */
  returnUrl: string;
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
  /** Empty string means the payload did not carry a provider payment/session id. */
  providerPaymentId: string;
  /** Provider refund id when the emitted event carries it. */
  providerRefundId?: string;
  /** Stable OnlyLive Payment id echoed by the provider. */
  paymentExternalId?: string;
  /**
   * Stable OnlyLive Order id echoed by the provider, when available, as a
   * second independent reconciliation invariant alongside paymentExternalId
   * (both come from the same echoed-back metadata object, so this is a
   * cross-check against a corrupted/mismatched claim, not a second source
   * of truth).
   */
  orderExternalId?: string;
  /** Stable OnlyLive Refund id/refundReference echoed by the provider. */
  refundExternalId?: string;
  type: PaymentWebhookEventType;
  /** Zero is only a placeholder when payloadValid=false; it is never trusted. */
  amountCents: number;
  /** Provider-normalized currency. ChariPay's documented contract is MAD-only. */
  currency: string;
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
 * Result of an explicit attempt to make an expired checkout session
 * non-payable before releasing its inventory. `non_payable` is the only
 * state that authorizes local cancellation/release. `unknown` is fail-closed:
 * the hold remains reserved until a signed webhook or human reconciliation
 * establishes what happened to the money.
 */
export interface ClosePaymentSessionResult {
  state: "non_payable" | "unknown";
  providerStatus?: string;
  correlationId?: string;
  retryAfterMs?: number;
}

export class ProviderInputError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ProviderInputError";
  }
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
    /** Parsed provider backoff hint when available. */
    public readonly retryAfterMs?: number,
    /** Provider correlation/request id for support diagnostics; never a secret. */
    public readonly correlationId?: string,
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
  /**
   * Make a hosted checkout session non-payable after OnlyLive's local checkout
   * deadline. Implementations must never return `non_payable` for a session
   * whose financial outcome is merely unknown or already consumed.
   */
  closePaymentSession(providerPaymentId: string, requestId: string): Promise<ClosePaymentSessionResult>;
}
