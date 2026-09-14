import crypto from "node:crypto";
import {
  ProviderRequestError,
  type CreatePaymentInput,
  type CreatePaymentResult,
  type ParsedWebhookEvent,
  type ParseWebhookInput,
  type PaymentProvider,
  type PaymentWebhookEventType,
  type RefundInput,
  type RefundResult,
  type RefundStatusResult,
} from "@/lib/payments/provider";

const CHARIPAY_API_BASE_URL = "https://api-psp.charipay.ma";
const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function requireHttpsUrl(value: string | undefined, label: string): string {
  if (!value) throw new Error(`ChariPay requires ${label}`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`ChariPay ${label} must be a valid HTTPS URL`);
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new Error(`ChariPay ${label} must use HTTPS on the default port without credentials`);
  }
  return url.toString();
}

function validateHostedCheckoutUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ProviderRequestError("ChariPay returned an invalid checkoutUrl", false);
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new ProviderRequestError("ChariPay returned an unsafe checkoutUrl", false);
  }
  return url.toString();
}

function centsToMad(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("ChariPay amount must be positive integer cents");
  return Number((cents / 100).toFixed(2));
}

function madToCents(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : undefined;
}

function safeHexEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actual) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature(rawBody: string, headers: Record<string, string>): boolean {
  const timestampRaw = headers["x-chari-timestamp"];
  const signatures = [headers["x-chari-signature"], headers["x-chari-signature-next"]]
    .filter((value): value is string => Boolean(value));
  if (!timestampRaw || signatures.length === 0) return false;

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > WEBHOOK_MAX_SKEW_MS) return false;

  const signed = `${timestampRaw}.${rawBody}`;
  const secrets = [process.env.CHARIPAY_WEBHOOK_SECRET, process.env.CHARIPAY_WEBHOOK_SECRET_NEXT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (secrets.length === 0) throw new Error("CHARIPAY_WEBHOOK_SECRET is not set");

  return signatures.some((signature) => secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
    return safeHexEqual(signature, expected);
  }));
}

interface ChariPayPaymentSessionResponse {
  sessionId?: unknown;
  checkoutUrl?: unknown;
}

interface ChariPayRefundResponse {
  refundId?: unknown;
  refundReference?: unknown;
  status?: unknown;
}

interface ChariPayWebhookBody {
  externalId?: unknown;
  amount?: unknown;
  currency?: unknown;
  refundId?: unknown;
  refundReference?: unknown;
  refundAmount?: unknown;
  sessionId?: unknown;
  metadata?: unknown;
}

function isRetryableOrAmbiguousStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderRequestError(
      `ChariPay returned non-JSON response (${response.status})`,
      isRetryableOrAmbiguousStatus(response.status),
      response.status,
    );
  }
}

async function parseApiResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof error?.code === "string" ? error.code : `HTTP_${response.status}`;
    const message = typeof error?.message === "string" ? error.message : "ChariPay request failed";
    throw new ProviderRequestError(
      `ChariPay ${code}: ${message}`,
      isRetryableOrAmbiguousStatus(response.status),
      response.status,
    );
  }
  return body;
}

function normalizeRefundStatus(value: unknown): RefundStatusResult["status"] | null {
  if (value === "PENDING") return "pending";
  if (value === "SUCCESS") return "succeeded";
  if (value === "FAILED") return "failed";
  return null;
}

export class ChariPayProvider implements PaymentProvider {
  readonly name = "charipay";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (input.currency !== "MAD") throw new Error(`ChariPay only supports MAD in this integration, got ${input.currency}`);
    const returnUrl = requireHttpsUrl(input.returnUrl, "returnUrl");
    const webhookUrl = requireHttpsUrl(input.webhookUrl, "webhookUrl");
    if (!input.expiresAt || input.expiresAt <= new Date()) {
      throw new Error("ChariPay requires a future checkout expiry");
    }

    const response = await fetch(`${CHARIPAY_API_BASE_URL}/v1/payment-sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY"),
        "Idempotency-Key": input.idempotencyKey,
        "X-Request-Id": input.paymentId,
      },
      body: JSON.stringify({
        amount: centsToMad(input.amountCents),
        orderId: input.orderId,
        singleUse: true,
        externalId: input.paymentId,
        expiresAt: input.expiresAt.toISOString(),
        notifyOnFailure: true,
        config: {
          customer: { email: input.customerEmail },
          urls: { accept: returnUrl, decline: returnUrl, notification: webhookUrl },
        },
        metadata: { onlylivePaymentId: input.paymentId, onlyliveOrderId: input.orderId },
      }),
    });

    const body = (await parseApiResponse(response)) as ChariPayPaymentSessionResponse;
    if (typeof body.sessionId !== "string" || typeof body.checkoutUrl !== "string") {
      throw new ProviderRequestError("ChariPay payment-session response is missing sessionId or checkoutUrl", false, response.status);
    }
    return {
      providerPaymentId: body.sessionId,
      redirectUrl: validateHostedCheckoutUrl(body.checkoutUrl),
    };
  }

  async parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent> {
    const signatureValid = verifySignature(input.rawBody, input.headers);
    const eventId = input.headers["chari-event-id"] ?? "";
    const eventTypeRaw = input.headers["chari-event-type"] ?? "";
    const supported = new Set<PaymentWebhookEventType>([
      "payment.succeeded",
      "payment.failed",
      "refund.succeeded",
      "refund.failed",
    ]);
    const eventType = supported.has(eventTypeRaw as PaymentWebhookEventType)
      ? eventTypeRaw as PaymentWebhookEventType
      : "payment.failed";

    let payload: ChariPayWebhookBody;
    try {
      payload = JSON.parse(input.rawBody) as ChariPayWebhookBody;
    } catch {
      return {
        externalEventId: eventId,
        providerPaymentId: "",
        type: eventType,
        amountCents: 0,
        currency: "MAD",
        signatureValid: false,
        payloadValid: false,
        raw: input.rawBody,
      };
    }

    const metadata = payload.metadata && typeof payload.metadata === "object"
      ? payload.metadata as Record<string, unknown>
      : {};
    const paymentExternalId = typeof payload.externalId === "string"
      ? payload.externalId
      : typeof metadata.onlylivePaymentId === "string"
        ? metadata.onlylivePaymentId
        : undefined;
    const refundExternalId = typeof payload.refundReference === "string" ? payload.refundReference : undefined;
    const normalizedAmount = eventType.startsWith("refund.")
      ? madToCents(payload.refundAmount)
      : madToCents(payload.amount);
    const currency = typeof payload.currency === "string" ? payload.currency : "MAD";
    const providerPaymentId = typeof payload.sessionId === "string" ? payload.sessionId : "";
    const providerRefundId = typeof payload.refundId === "string" ? payload.refundId : undefined;

    const payloadValid = Boolean(
      eventId
      && supported.has(eventTypeRaw as PaymentWebhookEventType)
      && normalizedAmount !== undefined
      && currency === "MAD"
      && (eventType.startsWith("refund.") ? refundExternalId : paymentExternalId || providerPaymentId),
    );

    return {
      externalEventId: eventId,
      providerPaymentId,
      providerRefundId,
      paymentExternalId,
      refundExternalId,
      type: eventType,
      amountCents: normalizedAmount ?? 0,
      currency,
      signatureValid,
      payloadValid,
      raw: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
    if (input.currency !== "MAD") throw new Error(`ChariPay only supports MAD refunds, got ${input.currency}`);
    const response = await fetch(`${CHARIPAY_API_BASE_URL}/v1/refunds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY"),
        "Idempotency-Key": input.idempotencyKey,
        "X-Request-Id": input.idempotencyKey,
      },
      body: JSON.stringify({
        externalId: input.paymentExternalId,
        refundReference: input.idempotencyKey,
        refundAmount: centsToMad(input.amountCents),
        reason: input.reason,
        metadata: { onlyliveRefundId: input.idempotencyKey },
      }),
    });

    const body = (await parseApiResponse(response)) as ChariPayRefundResponse;
    const providerRefundId = typeof body.refundId === "string"
      ? body.refundId
      : typeof body.refundReference === "string"
        ? body.refundReference
        : input.idempotencyKey;
    const status = normalizeRefundStatus(body.status);
    if (status === "failed") {
      throw new ProviderRequestError("ChariPay reports this refund reference as FAILED", false, response.status);
    }
    return { providerRefundId, state: status === "succeeded" ? "succeeded" : "processing" };
  }

  async getRefundStatus(refundReference: string): Promise<RefundStatusResult> {
    const response = await fetch(`${CHARIPAY_API_BASE_URL}/v1/refunds/${encodeURIComponent(refundReference)}`, {
      method: "GET",
      headers: { "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY") },
    });
    if (response.status === 404) {
      return { providerRefundId: null, status: "not_found" };
    }
    const body = (await parseApiResponse(response)) as ChariPayRefundResponse;
    const status = normalizeRefundStatus(body.status);
    if (!status) {
      throw new ProviderRequestError("ChariPay refund lookup returned an unknown status", false, response.status);
    }
    const providerRefundId = typeof body.refundId === "string"
      ? body.refundId
      : typeof body.refundReference === "string"
        ? body.refundReference
        : refundReference;
    return { providerRefundId, status };
  }
}
