import crypto from "node:crypto";
import type {
  CreatePaymentInput,
  CreatePaymentResult,
  ParsedWebhookEvent,
  ParseWebhookInput,
  PaymentProvider,
  PaymentWebhookEventType,
  RefundInput,
  RefundResult,
  RefundStatusResult,
} from "@/lib/payments/provider";

const CHARIPAY_API_BASE = "https://api-psp.charipay.ma";
const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

function requiredEnv(name: "CHARIPAY_API_KEY" | "CHARIPAY_WEBHOOK_SECRET"): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function requireMad(currency: string) {
  if (currency !== "MAD") {
    throw new Error(`ChariPay only supports MAD, received ${currency}`);
  }
}

function majorUnits(amountCents: number): number {
  if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
    throw new Error("Payment amount must be a positive integer number of cents");
  }
  return amountCents / 100;
}

function centsFromMajor(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const cents = Math.round(value * 100);
  if (Math.abs(value * 100 - cents) > 1e-6 || !Number.isSafeInteger(cents)) return undefined;
  return cents;
}

function requireHttps(value: string | undefined, label: string): string | undefined {
  if (!value) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`ChariPay ${label} must use HTTPS`);
  return url.toString();
}

function timingSafeHexEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(actual)) return false;
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function verifyWebhook(rawBody: string, headers: Record<string, string>): boolean {
  const signature = headers["x-chari-signature"];
  const timestamp = headers["x-chari-timestamp"];
  if (!signature || !timestamp || !/^\d+$/.test(timestamp)) return false;

  const timestampMs = Number(timestamp);
  if (!Number.isSafeInteger(timestampMs) || Math.abs(Date.now() - timestampMs) > WEBHOOK_MAX_SKEW_MS) return false;

  const expected = crypto
    .createHmac("sha256", requiredEnv("CHARIPAY_WEBHOOK_SECRET"))
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  return timingSafeHexEqual(signature, expected);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function metadataFromPayload(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const direct = asRecord(payload.metadata);
  if (direct) return direct;
  const data = asRecord(payload.data);
  return data ? asRecord(data.metadata) : undefined;
}

function findDocumentedValue(payload: Record<string, unknown>, key: string): unknown {
  if (payload[key] !== undefined) return payload[key];
  const data = asRecord(payload.data);
  return data?.[key];
}

function supportedEventType(value: string | undefined): PaymentWebhookEventType | undefined {
  switch (value) {
    case "payment.succeeded":
    case "payment.failed":
    case "refund.succeeded":
    case "refund.failed":
      return value;
    default:
      return undefined;
  }
}

function providerErrorMessage(status: number, body: unknown): string {
  const record = asRecord(body);
  const error = record ? asRecord(record.error) : undefined;
  const code = error ? stringValue(error.code) : undefined;
  const message = error ? stringValue(error.message) : undefined;
  const correlationId = record ? stringValue(record.correlationId) : undefined;
  return [
    `ChariPay request failed with HTTP ${status}`,
    code,
    message,
    correlationId ? `correlationId=${correlationId}` : undefined,
  ].filter(Boolean).join(" — ");
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`ChariPay returned non-JSON HTTP ${response.status}`);
  }
}

function refundStatus(body: unknown): RefundStatusResult["status"] {
  const record = asRecord(body);
  const value = record ? stringValue(findDocumentedValue(record, "status")) : undefined;
  switch (value) {
    case "SUCCESS": return "succeeded";
    case "FAILED": return "failed";
    case "PENDING": return "pending";
    default: throw new Error(`ChariPay refund response has unknown status: ${value ?? "missing"}`);
  }
}

export class ChariPayProvider implements PaymentProvider {
  readonly name = "charipay";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    requireMad(input.currency);
    const accept = requireHttps(input.returnUrl, "accept URL");
    const decline = requireHttps(input.declineUrl ?? input.returnUrl, "decline URL");
    const notification = requireHttps(input.notificationUrl, "notification URL");

    const response = await fetch(`${CHARIPAY_API_BASE}/v1/payment-sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chari-pay-api-key": requiredEnv("CHARIPAY_API_KEY"),
        "idempotency-key": input.idempotencyKey,
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        amount: majorUnits(input.amountCents),
        orderId: input.orderNumber ?? input.orderId,
        externalId: input.paymentId,
        singleUse: true,
        notifyOnFailure: true,
        ...(input.expiresAt ? { expiresAt: input.expiresAt.toISOString() } : {}),
        config: {
          customer: { email: input.customerEmail },
          urls: {
            ...(accept ? { accept } : {}),
            ...(decline ? { decline } : {}),
            ...(notification ? { notification } : {}),
          },
        },
        metadata: {
          onlyLivePaymentId: input.paymentId,
          onlyLiveAmountCents: input.amountCents,
          onlyLiveCurrency: input.currency,
        },
      }),
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(providerErrorMessage(response.status, body));
    const record = asRecord(body);
    const sessionId = record ? stringValue(record.sessionId) : undefined;
    const checkoutUrl = record ? stringValue(record.checkoutUrl) : undefined;
    if (!sessionId || !checkoutUrl) throw new Error("ChariPay create-session response is missing sessionId/checkoutUrl");

    return { providerPaymentId: sessionId, redirectUrl: checkoutUrl };
  }

  async parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent> {
    const signatureValid = verifyWebhook(input.rawBody, input.headers);
    const externalEventId = stringValue(input.headers["chari-event-id"]);
    const type = supportedEventType(stringValue(input.headers["chari-event-type"]));

    let payload: Record<string, unknown> | undefined;
    try {
      payload = asRecord(JSON.parse(input.rawBody) as unknown);
    } catch {
      payload = undefined;
    }

    if (!externalEventId || !type || !payload) {
      return {
        externalEventId: externalEventId ?? crypto.randomUUID(),
        type: type ?? "payment.failed",
        amountCents: 0,
        currency: "",
        signatureValid: false,
        raw: payload ?? input.rawBody,
      };
    }

    const metadata = metadataFromPayload(payload);
    const paymentExternalId =
      stringValue(metadata?.onlyLivePaymentId) ??
      stringValue(findDocumentedValue(payload, "externalId"));
    const refundReference =
      stringValue(metadata?.onlyLiveRefundId) ??
      stringValue(findDocumentedValue(payload, "refundReference"));
    const providerPaymentId =
      stringValue(findDocumentedValue(payload, "operationId")) ??
      stringValue(findDocumentedValue(payload, "sessionId"));

    const metadataAmount = metadata?.onlyLiveAmountCents;
    const documentedAmount = type.startsWith("refund.")
      ? findDocumentedValue(payload, "refundAmount") ?? findDocumentedValue(payload, "amount")
      : findDocumentedValue(payload, "amount");
    const amountCents =
      typeof metadataAmount === "number" && Number.isSafeInteger(metadataAmount)
        ? metadataAmount
        : centsFromMajor(documentedAmount) ?? 0;
    const currency =
      stringValue(metadata?.onlyLiveCurrency) ??
      stringValue(findDocumentedValue(payload, "currency")) ??
      "MAD";

    return {
      externalEventId,
      providerPaymentId,
      paymentExternalId,
      refundReference,
      type,
      amountCents,
      currency,
      signatureValid,
      raw: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    requireMad(input.currency);
    const response = await fetch(`${CHARIPAY_API_BASE}/v1/refunds`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-chari-pay-api-key": requiredEnv("CHARIPAY_API_KEY"),
        "x-request-id": crypto.randomUUID(),
      },
      body: JSON.stringify({
        externalId: input.paymentExternalId,
        refundReference: input.idempotencyKey,
        refundAmount: majorUnits(input.amountCents),
        reason: input.reason,
        metadata: {
          onlyLiveRefundId: input.idempotencyKey,
          onlyLivePaymentId: input.paymentExternalId,
          onlyLiveAmountCents: input.amountCents,
          onlyLiveCurrency: input.currency,
        },
      }),
    });

    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(providerErrorMessage(response.status, body));

    // ChariPay explicitly accepts refundReference as a GET /v1/refunds/{reference}
    // lookup key, so keeping our stable Refund.id is sufficient even when the
    // 202 response omits/changes a platform-specific refund id.
    const record = asRecord(body);
    const providerRefundId = record
      ? stringValue(record.refundId) ?? stringValue(record.refundReference) ?? input.idempotencyKey
      : input.idempotencyKey;
    const status = refundStatus(body);

    return {
      providerRefundId,
      status: status === "succeeded" ? "succeeded" : "pending",
    };
  }

  async getRefundStatus(refundReference: string): Promise<RefundStatusResult> {
    const response = await fetch(`${CHARIPAY_API_BASE}/v1/refunds/${encodeURIComponent(refundReference)}`, {
      method: "GET",
      headers: {
        "x-chari-pay-api-key": requiredEnv("CHARIPAY_API_KEY"),
        "x-request-id": crypto.randomUUID(),
      },
    });
    const body = await parseJsonResponse(response);
    if (!response.ok) throw new Error(providerErrorMessage(response.status, body));
    const record = asRecord(body);
    const providerRefundId = record
      ? stringValue(record.refundId) ?? stringValue(record.refundReference) ?? refundReference
      : refundReference;
    return { providerRefundId, status: refundStatus(body) };
  }
}

export function verifyChariPayWebhookSignature(rawBody: string, headers: Record<string, string>): boolean {
  return verifyWebhook(rawBody, headers);
}
