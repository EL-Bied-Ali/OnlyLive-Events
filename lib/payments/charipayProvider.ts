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
  type PaymentStatusLookupInput,
  type PaymentStatusLookupResult,
  type PaymentWebhookEventType,
  type RefundInput,
  type RefundResult,
  type RefundStatusResult,
} from "@/lib/payments/provider";
import { normalizePhone } from "@/lib/validation/phone";

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

// Delegates to the same normalizer lib/validation/auth.ts's phoneSchema uses,
// so "accepted at registration/phone-update time" and "accepted by ChariPay"
// can never drift apart (a real bug an independent audit caught: the two
// used to be separately-maintained regexes). Still needed here, not just at
// write time, for accounts whose phone predates this normalization landing.
function chariCustomerPhone(phone: string | null | undefined): string {
  const normalized = normalizePhone(phone);
  if (!normalized) {
    throw new ProviderInputError("PAYMENT_CUSTOMER_DETAILS_REQUIRED", "A valid phone number is required for payment");
  }
  return normalized;
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
  // Confirmed on a real sandbox POST /v1/refunds API response, 2026-09-22
  // (a direct synchronous response to our own request, not a signed
  // webhook delivery -- see docs/CHARIPAY.md's distinction between the
  // two): a 2xx response can carry a synchronously-known business failure
  // (in this case, a missing API-key scope) via these two fields, distinct
  // from an HTTP-level (non-2xx) rejection. Previously discarded entirely
  // -- the thrown error gave no indication of why, only that status was
  // "FAILED". See refund()'s status === "failed" branch.
  failureCode?: unknown;
  failureMessage?: unknown;
}

interface ChariPayTransaction {
  operationId?: unknown;
  type?: unknown;
  status?: unknown;
  amount?: unknown;
  currency?: unknown;
  direction?: unknown;
  externalReference?: unknown;
}

interface ChariPayTransactionListResponse {
  data?: unknown;
  hasMore?: unknown;
  nextCursor?: unknown;
}

interface ChariPayWebhookBody {
  // Observed on the real payment.succeeded sandbox body captured on
  // 2026-09-17. ChariPay's public integration guidance nevertheless defines
  // Chari-Event-Id as the delivery-header deduplication key, so this body field
  // is evidence only and is not used to redefine the provider's dedup key.
  WebhookEventId?: unknown;

  // Confirmed against a real signed sandbox delivery for payment.succeeded
  // (captured 2026-09-17 via ChariPay's partner webhook-events API,
  // GET /api/v1/partner/webhooks/events/{id}). ChariPay's own generated
  // fields on this webhook are PascalCased (Amount, ExternalId, Reference,
  // GatewayOrderId, ...) — the nested `metadata` object is the one
  // exception, echoed back exactly as sent in createPayment()'s request
  // body, so it keeps our own lowercase field names.
  Amount?: unknown;
  metadata?: unknown;

  // NOT yet confirmed against a real signed refund.* delivery — only
  // payment.succeeded has been captured so far (see docs/CHARIPAY.md's
  // sandbox acceptance checklist, still open for refunds). Both casings
  // are accepted defensively until a real refund webhook sample pins
  // this for real; metadata.onlyliveRefundId (see parseWebhook) is the
  // higher-confidence signal since it directly matches the confirmed
  // metadata-echo behavior above, rather than a guessed field name.
  RefundAmount?: unknown;
  refundAmount?: unknown;
  RefundReference?: unknown;
  refundReference?: unknown;
  RefundId?: unknown;
  refundId?: unknown;
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

const SAFE_PROVIDER_CODE = /^[A-Za-z0-9_]{1,64}$/;
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function safeProviderCode(value: unknown, status: number): string {
  return typeof value === "string" && SAFE_PROVIDER_CODE.test(value)
    ? value
    : `HTTP_${status}`;
}

function safeCorrelationId(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_CORRELATION_ID.test(value)
    ? value
    : undefined;
}

function responseCorrelationId(response: Response): string | undefined {
  for (const name of ["x-correlation-id", "correlation-id", "x-request-id"]) {
    const value = safeCorrelationId(response.headers.get(name));
    if (value) return value;
  }
  return undefined;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutMs =
    Number.isFinite(requestTimeoutMs) && requestTimeoutMs > 0
      ? Math.min(requestTimeoutMs, REQUEST_TIMEOUT_MS)
      : REQUEST_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
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

function extractProviderFieldHint(code: string, message: string): string | undefined {
  if (code !== "MISSING_PARAMETER") return undefined;

  // Never persist/log provider-controlled prose. Extract only a bounded
  // identifier-shaped field name from a small allowlist of validation-message
  // shapes. The trailing lookahead is deliberate: without it, a value such as
  // "buyer@example.com" could be truncated to "buyer" and misclassified as a
  // harmless field name.
  const patterns = [
    /missing\s+required\s+(?:parameter|field)\s*[:=]?\s*['"`]?([A-Za-z][A-Za-z0-9_.-]{0,63})['"`]?(?=$|[\s,.;)\]}])/i,
    /missing\s+(?:parameter|field)\s*[:=]?\s*['"`]?([A-Za-z][A-Za-z0-9_.-]{0,63})['"`]?(?=$|[\s,.;)\]}])/i,
    /required\s+(?:parameter|field)\s*[:=]?\s*['"`]?([A-Za-z][A-Za-z0-9_.-]{0,63})['"`]?(?=$|[\s,.;)\]}])/i,
    /(?:parameter|field)\s+['"`]?([A-Za-z][A-Za-z0-9_.-]{0,63})['"`]?\s+(?:is\s+)?(?:missing|required)\b/i,
    /['"`]?([A-Za-z][A-Za-z0-9_.-]{0,63})['"`]?\s+is\s+(?:missing|required)\b/i,
  ];

  for (const pattern of patterns) {
    const candidate = message.match(pattern)?.[1];
    if (candidate && !/^(parameter|field|required|missing|is)$/i.test(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// A 2xx POST /v1/refunds response can still carry a synchronously-known
// business failure (failureCode/failureMessage), confirmed on a real
// signed sandbox delivery, 2026-09-22 -- separate from the !response.ok
// path redactProviderMessage below covers. Same redaction discipline
// applies: sandbox-only exposure, provider-controlled prose never safe to
// persist/log verbatim.
function redactFailureMessage(
  message: string,
  knownValues: Array<string | number | null | undefined> = [],
): string | undefined {
  return redactProviderMessage("__FAILURE_MESSAGE__", message, knownValues, true);
}

function redactProviderMessage(
  code: string,
  message: string,
  knownValues: Array<string | number | null | undefined> = [],
  bypassCodeGate = false,
): string | undefined {
  if ((!bypassCodeGate && code !== "MISSING_PARAMETER") || !message || process.env.CHARIPAY_ENV !== "sandbox") return undefined;

  let redacted = message.replace(/[\u0000-\u001F\u007F]/g, " ");

  const exactValues = knownValues
    .map((value) => String(value ?? "").trim())
    .filter((value) => value.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const value of exactValues) {
    redacted = redacted.split(value).join("<redacted>");
  }

  redacted = redacted
    .replace(/chari_sk_(?:test|live)_[A-Za-z0-9_-]+/gi, "<api-key>")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "<email>")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "<url>")
    .replace(/\+?\d[\d\s().-]{7,}\d/g, "<number>");

  redacted = redacted.replace(/\s+/g, " ").trim();
  if (!redacted) return undefined;
  return redacted.length <= 240 ? redacted : redacted.slice(0, 237) + "...";
}

async function parseApiResponse(
  response: Response,
  knownValues: Array<string | number | null | undefined> = [],
): Promise<Record<string, unknown>> {
  const body = await readJsonResponse(response);
  if (!response.ok) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined;
    const code = safeProviderCode(error?.code, response.status);
    const message = typeof error?.message === "string" ? error.message : "ChariPay request failed";
    const outcomeUnknown = isRetryableOrAmbiguousStatus(response.status) || code === "IDEMPOTENCY_CONFLICT";
    const correlationId = safeCorrelationId(body.correlationId) ?? responseCorrelationId(response);
    const providerFieldHint = extractProviderFieldHint(code, message);
    const providerMessageHint = redactProviderMessage(code, message, knownValues);
    // Never retain provider-controlled prose in Error.message: callers may
    // log an exception object or its message. Keep only our fixed prefix plus
    // the machine code; sandbox-only diagnostics live in providerMessageHint,
    // which is separately redacted and never used as the thrown message.
    throw new ProviderRequestError(
      `ChariPay request failed (${code})`,
      outcomeUnknown,
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      correlationId,
      code,
      providerFieldHint,
      providerMessageHint,
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

function apiErrorCode(body: Record<string, unknown>, status: number): string {
  const error = body.error as { code?: unknown } | undefined;
  return safeProviderCode(error?.code, status);
}

export class ChariPayProvider implements PaymentProvider {
  readonly name = "charipay";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (input.currency !== "MAD") throw new Error(`ChariPay only supports MAD in this integration, got ${input.currency}`);
    const customerName = chariCustomerName(input.customerName);
    const customerPhone = chariCustomerPhone(input.customerPhone);
    const returnUrl = requireHttpsUrl(input.returnUrl, "returnUrl");
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
          // Webhooks are delivered through the separately registered partner
          // endpoint. Supplying a per-session notification URL makes ChariPay
          // auto-register a duplicate endpoint and can alter/drop URL query
          // parameters, so it is deliberately omitted here.
          urls: { accept: returnUrl, decline: returnUrl },
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
    // ChariPay explicitly documents Chari-Event-Id as the stable
    // deduplication key across delivery attempts. The signature authenticates
    // timestamp + rawBody, not this header, so financial outcome integrity is
    // bound separately in the route through the authenticated transaction
    // ledger before any payment/order/ticket mutation.
    //
    // Do not make this envelope id depend on a body field: the refund webhook
    // shape is intentionally still unverified, and its fail-closed gate must
    // remain reachable using only confirmed delivery-envelope facts.
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
    // The Amount + metadata.onlylivePaymentId interpretation below is
    // applied uniformly to both payment.* event types since they share the
    // same underlying operation envelope (only OperationStatus differs) —
    // but only payment.succeeded has actually been captured from a real
    // delivery. payment.failed is extrapolated, not independently
    // confirmed; capturing a real one remains meaningful since it releases
    // inventory and could reveal a genuinely different shape.

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

    // Only metadata.onlylivePaymentId is trusted to resolve the Payment
    // row. ChariPay's own ExternalId/Reference/CustomData fields on this
    // webhook are actually the ORDER id (confirmed against a real
    // delivery), not the Payment id — despite createPayment() itself
    // sending `externalId: input.paymentId` in the request, ChariPay's
    // webhook re-purposes that name for something else entirely.
    const paymentExternalId = typeof metadata.onlylivePaymentId === "string"
      ? metadata.onlylivePaymentId
      : undefined;

    // Second, required reconciliation invariant from the same confirmed
    // echoed-back metadata object — payloadValid below requires this for
    // payment events (not just paymentExternalId), and the route cross-checks
    // it against payment.orderId alongside paymentExternalId vs. payment.id.
    const orderExternalId = typeof metadata.onlyliveOrderId === "string"
      ? metadata.onlyliveOrderId
      : undefined;

    // Unverified — see the ChariPayWebhookBody comment above. metadata's
    // echo-back behavior is confirmed, so onlyliveRefundId is checked
    // first; the guessed top-level field names are a fallback only.
    const refundExternalId = typeof metadata.onlyliveRefundId === "string"
      ? metadata.onlyliveRefundId
      : typeof payload.RefundReference === "string"
        ? payload.RefundReference
        : typeof payload.refundReference === "string"
          ? payload.refundReference
          : undefined;

    const normalizedAmount = eventType.startsWith("refund.")
      ? madToCents(payload.RefundAmount ?? payload.refundAmount)
      : madToCents(payload.Amount);

    // Not parsed from the payload — there is no currency field on a real
    // ChariPay webhook to read (confirmed against a captured delivery, and
    // independently, ChariPay's own docs state amounts are MAD-only with
    // no currency field at all). This adapter only ever creates MAD
    // transactions (enforced at request time by createPayment()/refund()),
    // so MAD is assigned here as that known fact, then the route separately
    // checks it against the stored Payment's own currency.
    const currency = "MAD";
    // No sessionId-equivalent field exists on a real ChariPay webhook —
    // the route already falls back to matching by paymentExternalId alone
    // when this is empty (see "reconciles a payment webhook by externalId
    // when sessionId is absent").
    const providerPaymentId = "";
    const providerRefundId = typeof payload.RefundId === "string"
      ? payload.RefundId
      : typeof payload.refundId === "string"
        ? payload.refundId
        : undefined;

    // A real captured payment.succeeded delivery confirmed metadata carries
    // BOTH onlylivePaymentId and onlyliveOrderId (createPayment() sends both
    // in the same metadata object — see createPayment() above), so a payment
    // event is only valid when both are present: orderExternalId is a
    // required second reconciliation invariant, not an optional bonus check.
    const payloadValid = Boolean(
      eventId
      && supported.has(eventTypeRaw as PaymentWebhookEventType)
      && normalizedAmount !== undefined
      && (eventType.startsWith("refund.") ? refundExternalId : (paymentExternalId && orderExternalId)),
    );

    return {
      externalEventId: eventId,
      providerPaymentId,
      providerRefundId,
      paymentExternalId,
      orderExternalId,
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

    const parseOperationId = (value: string): number => {
      if (!/^\d+$/.test(value)) {
        throw new ProviderRequestError(
          "ChariPay returned an invalid operationId before refund submission",
          false,
          undefined,
          undefined,
          undefined,
          "INVALID_PROVIDER_OPERATION_ID",
        );
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new ProviderRequestError(
          "ChariPay operationId is outside the supported integer range",
          false,
          undefined,
          undefined,
          undefined,
          "INVALID_PROVIDER_OPERATION_ID",
        );
      }
      return parsed;
    };

    let operationId =
      input.providerOperationId !== undefined
        ? parseOperationId(input.providerOperationId)
        : undefined;

    if (
      operationId === undefined
      && input.orderExternalId
      && Number.isInteger(input.paymentAmountCents)
      && (input.paymentAmountCents ?? 0) > 0
    ) {
      let lookup: PaymentStatusLookupResult;
      try {
        lookup = await this.lookupPaymentStatus({
          orderExternalId: input.orderExternalId,
          amountCents: input.paymentAmountCents!,
          currency: input.currency,
        });
      } catch (error) {
        const providerError = error instanceof ProviderRequestError ? error : null;
        // No POST /refunds has happened yet, so the refund outcome is known:
        // nothing was submitted. Preserve provider diagnostics/backoff but
        // never classify a pre-submit lookup failure as financially ambiguous.
        throw new ProviderRequestError(
          "ChariPay original payment lookup failed before refund submission",
          false,
          providerError?.status,
          providerError?.retryAfterMs,
          providerError?.correlationId,
          providerError?.providerCode ?? "ORIGINAL_PAYMENT_LOOKUP_FAILED",
        );
      }

      if (lookup.status !== "succeeded" || !lookup.providerOperationId) {
        throw new ProviderRequestError(
          "ChariPay original payment could not be verified before refund submission",
          false,
          undefined,
          undefined,
          undefined,
          "ORIGINAL_PAYMENT_NOT_VERIFIED",
        );
      }
      operationId = parseOperationId(lookup.providerOperationId);
    }

    const response = await fetchWithTimeout(`${CHARIPAY_API_BASE_URL}/v1/refunds`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY"),
        "Idempotency-Key": input.idempotencyKey,
        "X-Request-Id": input.idempotencyKey,
      },
      body: JSON.stringify({
        // Prefer ChariPay's canonical ledger operationId once OnlyLive has
        // independently resolved and verified the original SUCCESS payment.
        // The public contract allows operationId OR externalId. Real sandbox
        // evidence on 2026-09-18 showed the documented externalId path returned
        // HTTP 400/MISSING_PARAMETER despite sending every documented required
        // field, so operationId is now the evidence-backed path for production
        // refund submissions. Keep the externalId fallback only for callers
        // that have not resolved a ledger operation yet (e.g. isolated unit
        // tests / non-ChariPay-compatible provider plumbing).
        ...(operationId !== undefined ? { operationId } : { externalId: input.paymentExternalId }),
        refundReference: input.idempotencyKey,
        refundAmount: centsToMad(input.amountCents),
        // A second, distinct real sandbox 400/MISSING_PARAMETER (2026-09-22,
        // correlation id 9bd23512-ab87-4022-8f7b-3a19a9706850) showed the
        // operationId fix above was necessary but not sufficient: ChariPay's
        // `reason` is a closed enum (MERCHANT_CANCELLATION /
        // CUSTOMER_CANCELLATION / PLATFORM_ORCHESTRATION / OTHER), not free
        // text -- the provider's own error said so verbatim: "Free text
        // belongs in note." OnlyLive's generic RefundInput.reason is admin-
        // entered free text (an internal note per docs/PAYMENTS.md, never
        // shown to the customer), so it maps to ChariPay's `note`, never to
        // `reason`. This adapter has no provider-recognized category signal
        // from the generic admin refund form to pick a specific enum value
        // honestly, so `reason` is fixed to the least presumptive option,
        // "OTHER", rather than guessing e.g. CUSTOMER_CANCELLATION for a
        // refund that might have been merchant- or admin-initiated.
        reason: "OTHER",
        note: input.reason,
        metadata: { onlyliveRefundId: input.idempotencyKey },
      }),
    });

    const body = (await parseApiResponse(response, [
      input.providerPaymentId,
      input.paymentExternalId,
      input.orderExternalId,
      input.idempotencyKey,
      input.reason,
      operationId,
    ])) as ChariPayRefundResponse;
    const providerRefundId = typeof body.refundId === "string"
      ? body.refundId
      : typeof body.refundReference === "string"
        ? body.refundReference
        : input.idempotencyKey;
    const status = normalizeRefundStatus(body.status);
    if (status === "failed") {
      // Confirmed on a real sandbox POST /v1/refunds API response,
      // 2026-09-22 (a direct synchronous response, not a signed webhook
      // delivery): a 2xx response can carry a synchronously-known business
      // failure via these two fields (in this case, a missing API-key
      // scope), separate from an HTTP-level rejection. Previously
      // discarded entirely -- the thrown error gave no indication of why
      // beyond "status was FAILED". Surface them the same safe way the
      // !response.ok path already does: a bounded machine code plus a
      // sandbox-only redacted message, never raw provider prose.
      const failureCode = typeof body.failureCode === "string"
        ? safeProviderCode(body.failureCode, response.status)
        : undefined;
      const failureMessage = typeof body.failureMessage === "string"
        ? redactFailureMessage(body.failureMessage, [
            input.providerPaymentId,
            input.paymentExternalId,
            input.orderExternalId,
            input.idempotencyKey,
            input.reason,
            operationId,
          ])
        : undefined;
      throw new ProviderRequestError(
        "ChariPay reports this refund reference as FAILED",
        false,
        response.status,
        undefined,
        responseCorrelationId(response),
        failureCode,
        undefined,
        failureMessage,
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

  async lookupPaymentStatus(input: PaymentStatusLookupInput): Promise<PaymentStatusLookupResult> {
    // Real sandbox responses (captured 2026-09-17) expose the OnlyLive Order
    // id as externalReference. The Payment id is not searchable there.
    if (input.currency !== "MAD") {
      return { status: "ambiguous", providerStatus: "CURRENCY_MISMATCH" };
    }

    const params = new URLSearchParams({
      type: "PAYMENT",
      search: input.orderExternalId,
      limit: "50",
    });
    const response = await fetchWithTimeout(
      `${CHARIPAY_API_BASE_URL}/v1/transactions?${params.toString()}`,
      {
        method: "GET",
        headers: { "X-CHARI-PAY-API-KEY": requiredEnv("CHARIPAY_API_KEY") },
      },
      input.requestTimeoutMs,
    );
    const body = (await parseApiResponse(response)) as ChariPayTransactionListResponse;
    if (!Array.isArray(body.data) || typeof body.hasMore !== "boolean") {
      throw new ProviderRequestError(
        "ChariPay transaction lookup returned a malformed list",
        true,
        response.status,
        undefined,
        responseCorrelationId(response),
      );
    }

    // Never declare success from a truncated search result: another exact
    // reference could exist on a later page and make the match ambiguous.
    if (body.hasMore) {
      return { status: "ambiguous", providerStatus: "SEARCH_TRUNCATED" };
    }

    const exactMatches = body.data.filter((entry): entry is ChariPayTransaction => {
      return Boolean(
        entry
        && typeof entry === "object"
        && !Array.isArray(entry)
        && (entry as ChariPayTransaction).externalReference === input.orderExternalId,
      );
    });

    if (exactMatches.length === 0) return { status: "not_found" };
    if (exactMatches.length !== 1) {
      return { status: "ambiguous", providerStatus: "MULTIPLE_EXACT_MATCHES" };
    }

    const transaction = exactMatches[0]!;
    const providerStatus = typeof transaction.status === "string" ? transaction.status : undefined;
    const providerOperationId =
      typeof transaction.operationId === "number" && Number.isFinite(transaction.operationId)
        ? String(transaction.operationId)
        : typeof transaction.operationId === "string" && transaction.operationId.length > 0
          ? transaction.operationId
          : undefined;
    const amountCents = madToCents(transaction.amount);

    const immutableFactsMatch =
      providerOperationId !== undefined
      && transaction.type === "PAYMENT"
      && transaction.direction === "IN"
      && transaction.currency === "MAD"
      && transaction.currency === input.currency
      && amountCents === input.amountCents;

    if (!immutableFactsMatch) {
      return { status: "ambiguous", providerOperationId, providerStatus };
    }

    if (providerStatus === "SUCCESS") {
      return { status: "succeeded", providerOperationId, providerStatus };
    }
    if (providerStatus === "PENDING" || providerStatus === "PENDING_3DS") {
      return { status: "pending", providerOperationId, providerStatus };
    }
    if (providerStatus === "FAILED") {
      return { status: "failed", providerOperationId, providerStatus };
    }
    if (providerStatus === "CANCELED") {
      return { status: "cancelled", providerOperationId, providerStatus };
    }
    return { status: "ambiguous", providerOperationId, providerStatus };
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
    // trusted to widen this authorization to release inventory — only the
    // diagnostic fields below (never `state`) reflect what it actually said.
    if (response.ok) {
      // Best-effort only: a malformed/empty body on an already-successful
      // (2xx) cancel must never turn a definitive success into an ambiguous
      // failure — this is diagnostic pinning of ChariPay's real sandbox
      // response shape (see TASKS.md's ChariPay acceptance #14 writeup), not
      // a new source of authorization.
      // No fallback value here: fabricating a "CANCELLED" providerStatus
      // when nothing was actually observed would record false acceptance
      // evidence and defeat the point of pinning ChariPay's real shape
      // (independent audit (GPT) caught this) — `undefined` (persisted as
      // `null`) honestly means "this response carried no parseable status".
      let observedStatus: string | undefined;
      try {
        const successBody = await readJsonResponse(response);
        if (typeof successBody.status === "string") observedStatus = successBody.status;
      } catch {
        // Ignore: absence of a parseable body tells us nothing new and must
        // not affect the outcome.
      }
      return {
        state: "non_payable",
        providerStatus: observedStatus,
        correlationId,
        httpStatus: response.status,
      };
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonResponse(response);
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw new ProviderRequestError("ChariPay session cancellation response could not be read", true, response.status);
    }
    const code = apiErrorCode(body, response.status);

    // 410 is the other provider state that proves a checkout can no longer be
    // paid. In contrast, 409 may mean already paid OR already cancelled; never
    // guess which one. 404 can also indicate environment/key drift. Both remain
    // fail-closed until a signed webhook or human reconciliation resolves them.
    if (response.status === 410 && code === "SESSION_EXPIRED") {
      return { state: "non_payable", providerStatus: code, correlationId, httpStatus: response.status, providerCode: code };
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
        httpStatus: response.status,
        providerCode: code,
      };
    }

    throw new ProviderRequestError(
      `ChariPay session cancellation failed (${code})`,
      isRetryableOrAmbiguousStatus(response.status),
      response.status,
      parseRetryAfterMs(response.headers.get("retry-after")),
      correlationId,
      code,
    );
  }
}
