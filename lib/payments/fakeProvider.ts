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

function getWebhookSecret(): string {
  const secret = process.env.FAKE_PSP_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error("FAKE_PSP_WEBHOOK_SECRET is not set");
  }
  return secret;
}

export function signFakeWebhookPayload(rawBody: string): string {
  return crypto.createHmac("sha256", getWebhookSecret()).update(rawBody).digest("hex");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

interface FakeWebhookPayload {
  eventId: string;
  providerPaymentId: string;
  paymentExternalId?: string;
  refundExternalId?: string;
  type: PaymentWebhookEventType;
  amountCents: number;
  currency: string;
}

/**
 * Simulates a hosted-checkout PSP for local dev/testing without inventing
 * a real API. The fake refund remains immediately successful so the existing
 * local browser flow stays fast; the provider interface can also represent
 * ChariPay's asynchronous refund lifecycle.
 */
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
    const signatureValid = typeof signature === "string" && signature.length > 0 && timingSafeEqualHex(signature, expected);

    let payload: FakeWebhookPayload;
    try {
      payload = JSON.parse(input.rawBody) as FakeWebhookPayload;
    } catch {
      return {
        externalEventId: crypto.randomUUID(),
        providerPaymentId: "",
        type: "payment.failed",
        amountCents: 0,
        currency: "",
        signatureValid: false,
        raw: input.rawBody,
      };
    }

    return {
      externalEventId: payload.eventId,
      providerPaymentId: payload.providerPaymentId,
      paymentExternalId: payload.paymentExternalId,
      refundExternalId: payload.refundExternalId,
      type: payload.type,
      amountCents: payload.amountCents,
      currency: payload.currency,
      signatureValid,
      raw: payload,
    };
  }

  async refund(_input: RefundInput): Promise<RefundResult> {
    return {
      providerRefundId: `fake_refund_${crypto.randomUUID()}`,
      state: "succeeded",
    };
  }
}
