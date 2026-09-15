import crypto from "node:crypto";
import {
  ProviderInputError,
  ProviderRequestError,
  type ClosePaymentSessionResult,
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
const REQUEST_TIMEOUT_MS = 12_000;

function chariCustomerName(name: string | null | undefined): { firstName: string; lastName: string } {
  const parts = name?.trim().split(/\s+/).filter(Boolean) ?? [];
  const firstName = parts[0] ?? "";
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : firstName;
  if (!firstName || !lastName) {
    throw new ProviderInputError("PAYMENT_CUSTOMER_DETAILS_REQUIRED", "A customer name is required for payment");
  }
  return { firstName, lastName };
}

function chariCustomerPhone(phone: string | null | undefined): string {
  let value = phone?.trim().replace(/[\s().-]/g, "") ?? "";
  if (value.startsWith("00")) value = `+${value.slice(2)}`;
  else if (/^0[5-7]\d{8}$/.test(value)) value = `+212${value.slice(1)}`;
  else if (/^212[5-7]\d{8}$/.test(value)) value = `+${value}`;
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new ProviderInputError("PAYMENT_CUSTOMER_DETAILS_REQUIRED", "A valid phone number is required for payment");
  }
  return value;
}

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
    throw new ProviderRequestError("ChariPay returned an invalid checkoutUrl", true);
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password) {
    throw new ProviderRequestError("ChariPay returned an unsafe checkoutUrl", true);
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
  if (!/^[0-9a-f]{64}$/i.test(actual) || !/^[0-9a-f]{64}$/i.test(expected)) return false;
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return crypto.timingSafeEqual(a, b);
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
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

function responseCorrelationId(response: Response): string | undefined {
  return response.headers.get("x-correlation-id")
    ?? response.headers.get("correlation-id")
    ?? response.headers.get("x-request-id")
    ?? undefined;
}

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new ProviderRequestError("ChariPay request timed out", true);
    }
    throw new ProviderRequestError("ChariPay request failed before a definitive response", true);
  } finally {
    clearTimeout(timeout);
  }
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new ProviderRequestError(
      `ChariPay returned non-JSON response (${response.status})`,
      response.ok || isRetryableOrAmbiguousStatus(response.status),
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      responseCorrelationId(response),
    );
  }
}

async function parseApiResponse(response: Response): Promise<Record<string, unknown>> {
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof error?.code === "string" ? error.code : `HTTP_${response.status}`;
    const message = typeof error?.message === "string" ? error.message : "ChariPay request failed";
    const outcomeUnknown = isRetryableOrAmbiguousStatus(response.status) || code === "IDEMPOTENCY_CONFLICT";
    const correlationId = typeof body.correlationId === "string"
      ? body.correlationId
      : responseCorrelationId(response);
    throw new ProviderRequestError(
      `ChariPay ${code}: ${message}`,
      outcomeUnknown,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      correlationId,
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

function apiErrorCode(body: Record<string, unknown>): string | undefined {
  const error = body.error as { code?: unknown } | undefined;
  return typeof error?.code === "string" ? error.code : undefined;
}

export class ChariPayProvider implements PaymentProvider {
  readonly name = "charipay";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (input.currency !== "MAD") throw new Error(`ChariPay only supports MAD in this integration, got ${input.currency}`);
    const customerName = chariCustomerName(input.customerName);
    const customerPhone = chariCustomerPhone(input.customerPhone);
    const returnUrl = requireHttpsUrl(input.returnUrl, "returnUrl");
    const webhookUrl = requireHttpsUrl(input.webhookUrl, "webhookUrl");
    if (!input.expiresAt || input.expiresAt <= new Date()) {
      throw new Error("ChariPay requires a future checkout expiry");
    }

    const response = await fetchWithTimeout(`${CHARIPAY_API_BASE_URL}/v1/payment-sessions`, {
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
          customer: {
            firstName: customerName.firstName,
            lastName: customerName.lastName,
            email: input.customerEmail,
            phone: customerPhone,
          },
          urls: { accept: returnUrl, decline: returnUrl, notification: webhookUrl },
        },
        metadata: { onlylivePaymentId: input.paymentId, onlyliveOrderId: input.orderId },
      }),
    });

    const body = (await parseApiResponse(response)) as ChariPayPaymentSessionResponse;
    if (typeof body.sessionId !== "string" || typeof body.checkoutUrl !== "string") {
      throw new ProviderRequestError(
        "ChariPay payment-session response is missing sessionId or checkoutUrl",
        true,
        response.status,
        undefined,
        responseCorrelationId(response),
      );
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
    const currency = typeof payload.currency === "string" ? payload.currency : "";
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
    const response = await fetchWithTimeout(`${CHARIPAY_API_BASE_URL}/v1/refunds`, {
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
      throw new ProviderRequestError(
        "ChariPay reports this refund reference as FAILED",
        false,
        response.status,
        undefined,
        responseCorrelationId(response),
      );
    }
    // A successful HTTP response without a definitive terminal status is kept
    // processing. The stable refundReference remains reserved for reconciliation.
    return { providerRefundId, state: status === "succeeded" ? "succeeded" : "processing" };
  }

  async getRefundStatus(refundReference: string): Promise<RefundStatusResult> {
    const response = await fetchWithTimeout(`${CHARIPAY_API_BASE_URL}/v1/refunds/${encodeURIComponent(refundReference)}`, {
      method: "GET",
      headers: { "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY") },
    });
    if (response.status === 404) {
      return { providerRefundId: null, status: "not_found" };
    }
    const body = (await parseApiResponse(response)) as ChariPayRefundResponse;
    const status = normalizeRefundStatus(body.status);
    if (!status) {
      throw new ProviderRequestError(
        "ChariPay refund lookup returned an unknown status",
        true,
        response.status,
        undefined,
        responseCorrelationId(response),
      );
    }
    const providerRefundId = typeof body.refundId === "string"
      ? body.refundId
      : typeof body.refundReference === "string"
        ? body.refundReference
        : refundReference;
    return { providerRefundId, status };
  }

  async closePaymentSession(providerPaymentId: string, requestId: string): Promise<ClosePaymentSessionResult> {
    const response = await fetchWithTimeout(
      `${CHARIPAY_API_BASE_URL}/v1/payment-sessions/${encodeURIComponent(providerPaymentId)}/cancel`,
      {
        method: "POST",
        headers: {
          "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY"),
          "X-Request-Id": requestId,
        },
      },
    );
    const correlationId = responseCorrelationId(response);

    // The endpoint contract is explicit: a successful cancel makes the session
    // non-payable. The response body is informational and is deliberately not
    // trusted to widen this authorization to release inventory.
    if (response.ok) {
      return { state: "non_payable", providerStatus: "CANCELLED", correlationId };
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonResponse(response);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError("ChariPay session cancellation response could not be read", true, response.status);
    }
    const code = apiErrorCode(body) ?? `HTTP_${response.status}`;

    // 410 is the other provider state that proves a checkout can no longer be
    // paid. In contrast, 409 may mean already paid OR already cancelled; never
    // guess which one. 404 can also indicate environment/key drift. Both remain
    // fail-closed until a signed webhook or human reconciliation resolves them.
    if (response.status === 410 && code === "SESSION_EXPIRED") {
      return { state: "non_payable", providerStatus: code, correlationId };
    }
    if (
      (response.status === 409 && (code === "SESSION_ALREADY_CONSUMED" || code === "SESSION_NOT_ACTIVE"))
      || (response.status === 404 && code === "SESSION_NOT_FOUND")
    ) {
      return {
        state: "unknown",
        providerStatus: code,
        correlationId,
        retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
      };
    }

    const error = body.error as { message?: unknown } | undefined;
    const message = typeof error?.message === "string" ? error.message : "ChariPay session cancellation failed";
    throw new ProviderRequestError(
      `ChariPay ${code}: ${message}`,
      isRetryableOrAmbiguousStatus(response.status),
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      correlationId,
    );
  }
}
