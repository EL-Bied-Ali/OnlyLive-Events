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

function getWebhookSecret(): string {
  const secret = process.env.FAKE_PSP_WEBHOOK_SECRET;
  if (!secret) throw new Error("FAKE_PSP_WEBHOOK_SECRET is not set");
  return secret;
}

export function signFakeWebhookPayload(rawBody: string): string {
  return crypto.createHmac("sha256", getWebhookSecret()).update(rawBody).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  return crypto.timingSafeEqual(bufA, bufB);
}

interface FakeWebhookPayload {
  eventId: string;
  providerPaymentId: string;
  providerRefundId?: string;
  paymentExternalId?: string;
  refundExternalId?: string;
  type: PaymentWebhookEventType;
  amountCents: number;
  currency: string;
}

function isFakePayload(payload: Partial<FakeWebhookPayload>): payload is FakeWebhookPayload {
  return typeof payload.eventId === "string"
    && typeof payload.providerPaymentId === "string"
    && typeof payload.type === "string"
    && Number.isInteger(payload.amountCents)
    && typeof payload.currency === "string";
}

export class FakeProvider implements PaymentProvider {
  readonly name = "fake";

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    return {
      providerPaymentId: `fake_${crypto.randomUUID()}`,
      redirectUrl: `/pay/fake/${input.paymentId}`,
    };
  }

  async parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent> {
    const signature = input.headers["x-onlylive-fake-signature"];
    const expected = signFakeWebhookPayload(input.rawBody);
    const signatureValid = typeof signature === "string"
      && signature.length > 0
      && timingSafeEqualHex(signature, expected);

    let payload: Partial<FakeWebhookPayload>;
    try {
      payload = JSON.parse(input.rawBody) as Partial<FakeWebhookPayload>;
    } catch {
      return {
        externalEventId: "",
        providerPaymentId: "",
        type: "payment.failed",
        amountCents: 0,
        currency: "",
        signatureValid: false,
        payloadValid: false,
        raw: input.rawBody,
      };
    }

    const payloadValid = isFakePayload(payload);
    return {
      externalEventId: typeof payload.eventId === "string" ? payload.eventId : "",
      providerPaymentId: typeof payload.providerPaymentId === "string" ? payload.providerPaymentId : "",
      providerRefundId: typeof payload.providerRefundId === "string" ? payload.providerRefundId : undefined,
      paymentExternalId: typeof payload.paymentExternalId === "string" ? payload.paymentExternalId : undefined,
      refundExternalId: typeof payload.refundExternalId === "string" ? payload.refundExternalId : undefined,
      type: (typeof payload.type === "string" ? payload.type : "payment.failed") as PaymentWebhookEventType,
      amountCents: typeof payload.amountCents === "number" ? payload.amountCents : 0,
      currency: typeof payload.currency === "string" ? payload.currency : "",
      signatureValid,
      payloadValid,
      raw: payload,
    };
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    return {
      providerRefundId: `fake_refund_${crypto.randomUUID()}`,
      state: "succeeded",
    };
  }

  async getRefundStatus(refundReference: string): Promise<RefundStatusResult> {
    return { providerRefundId: refundReference, status: "succeeded" };
  }
}
