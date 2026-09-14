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
} from "@/lib/payments/provider";

const CHARIPAY_API_BASE_URL = "https://api-psp.charipay.ma";
const WEBHOOK_MAX_SKEW_MS = 5 * 60 * 1000;

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

function centsToMad(cents: number): number {
  if (!Number.isInteger(cents) || cents <= 0) throw new Error("ChariPay amount must be positive integer cents");
  return Number((cents / 100).toFixed(2));
}

function madToCents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  const cents = Math.round(value * 100);
  return Math.abs(value * 100 - cents) < 1e-6 ? cents : null;
}

function safeHexEqual(actual: string, expected: string): boolean {
  if (!/^[0-9a-f]+$/i.test(actual) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const a = Buffer.from(actual, "hex");
  const b = Buffer.from(expected, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifySignature(rawBody: string, headers: Record<string, string>): boolean {
  const timestampRaw = headers["x-chari-timestamp"];
  const signature = headers["x-chari-signature"];
  if (!timestampRaw || !signature) return false;

  const timestamp = Number(timestampRaw);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > WEBHOOK_MAX_SKEW_MS) return false;

  const signed = `${timestampRaw}.${rawBody}`;
  const secrets = [process.env.CHARIPAY_WEBHOOK_SECRET, process.env.CHARIPAY_WEBHOOK_SECRET_NEXT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  if (secrets.length === 0) throw new Error("CHARIPAY_WEBHOOK_SECRET is not set");

  return secrets.some((secret) => {
    const expected = crypto.createHmac("sha256", secret).update(signed).digest("hex");
    return safeHexEqual(signature, expected);
  });
}

interface ChariPayPaymentSessionResponse {
  sessionId?: unknown;
  checkoutUrl?: unknown;
  correlationId?: unknown;
}

interface ChariPayRefundResponse {
  refundId?: unknown;
  refundReference?: unknown;
  status?: unknown;
  correlationId?: unknown;
}

interface ChariPayWebhookBody {
  externalId?: unknown;
  amount?: unknown;
  currency?: unknown;
  refundReference?: unknown;
  refundAmount?: unknown;
  sessionId?: unknown;
  metadata?: unknown;
}

async function parseApiResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  if (text) {
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new Error(`ChariPay returned non-JSON response (${response.status})`);
    }
  }
  if (!response.ok) {
    const error = body.error as { code?: unknown; message?: unknown } | undefined;
    const code = typeof error?.code === "string" ? error.code : `HTTP_${response.status}`;
    const message = typeof error?.message === "string" ? error.message : "ChariPay request failed";
    const correlationId = typeof body.correlationId === "string" ? ` correlationId=${body.correlationId}` : "";
    throw new Error(`ChariPay ${code}: ${message}${correlationId}`);
  }
  return body;
}

/**
 * ChariPay adapter pinned to the provider's published v1 contract:
 * hosted payment sessions, API-key authentication, HMAC/timestamp webhooks,
 * and asynchronous refunds. No card data ever enters OnlyLive.
 */
export class ChariPayProvider implements PaymentProvider {
  readonly name = "charipay";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    if (input.currency !== "MAD") throw new Error(`ChariPay only supports MAD in this integration, got ${input.currency}`);

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
        externalId: input.paymentId,
        config: {
          customer: { email: input.customerEmail },
          urls: {
            accept: input.returnUrl,
            decline: input.returnUrl,
            notification: input.webhookUrl,
          },
        },
        metadata: {
          onlylivePaymentId: input.paymentId,
          onlyliveOrderId: input.orderId,
        },
      }),
    });

    const body = (await parseApiResponse(response)) as ChariPayPaymentSessionResponse;
    if (typeof body.sessionId !== "string" || typeof body.checkoutUrl !== "string") {
      throw new Error("ChariPay payment-session response is missing sessionId or checkoutUrl");
    }
    return { providerPaymentId: body.sessionId, redirectUrl: body.checkoutUrl };
  }

  async parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent> {
    const signatureValid = verifySignature(input.rawBody, input.headers);
    const eventId = input.headers["chari-event-id"] ?? "";
    const eventType = input.headers["chari-event-type"] ?? "";

    let payload: ChariPayWebhookBody;
    try {
      payload = JSON.parse(input.rawBody) as ChariPayWebhookBody;
    } catch {
      return {
        externalEventId: eventId,
        providerPaymentId: "",
        type: "payment.failed",
        amountCents: 0,
        currency: "MAD",
        signatureValid: false,
        raw: input.rawBody,
      };
    }

    const supported = new Set<PaymentWebhookEventType>([
      "payment.succeeded",
      "payment.failed",
      "refund.succeeded",
      "refund.failed",
    ]);
    if (!supported.has(eventType as PaymentWebhookEventType) || !eventId) {
      return {
        externalEventId: eventId,
        providerPaymentId: "",
        type: "payment.failed",
        amountCents: 0,
        currency: "MAD",
        signatureValid: false,
        raw: payload,
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
    const amountCents = eventType.startsWith("refund.")
      ? madToCents(payload.refundAmount) ?? 0
      : madToCents(payload.amount) ?? 0;

    return {
      externalEventId: eventId,
      providerPaymentId: typeof payload.sessionId === "string" ? payload.sessionId : "",
      paymentExternalId,
      refundExternalId,
      type: eventType as PaymentWebhookEventType,
      amountCents,
      currency: typeof payload.currency === "string" ? payload.currency : "MAD",
      signatureValid,
      raw: payload,
    };
  }

  async refund(input: RefundInput): Promise<RefundResult> {
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
        : null;
    return { providerRefundId, state: "processing" };
  }
}
