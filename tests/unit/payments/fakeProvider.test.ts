import { describe, expect, it } from "vitest";
import { FakeProvider, signFakeWebhookPayload } from "@/lib/payments/fakeProvider";

describe("FakeProvider", () => {
  it("createPayment never makes an external call — redirects to our own sandbox page", async () => {
    const provider = new FakeProvider();
    const result = await provider.createPayment({
      paymentId: "pay_1",
      orderId: "order_1",
      amountCents: 1000,
      currency: "MAD",
      idempotencyKey: "idem_1",
      customerEmail: "buyer@example.com",
      customerFirstName: "Amine",
      customerLastName: "Bennani",
      customerPhone: "+212600000000",
      returnUrl: "http://localhost/orders/order_1",
    });

    expect(result.redirectUrl).toBe("/pay/fake/pay_1");
    expect(result.providerPaymentId).toMatch(/^fake_/);
  });

  it("accepts a correctly signed webhook payload", async () => {
    const provider = new FakeProvider();
    const payload = JSON.stringify({
      eventId: "evt_1",
      providerPaymentId: "fake_1",
      type: "payment.succeeded",
      amountCents: 1000,
    });
    const signature = signFakeWebhookPayload(payload);

    const parsed = await provider.parseWebhook({
      rawBody: payload,
      headers: { "x-onlylive-fake-signature": signature },
    });

    expect(parsed.signatureValid).toBe(true);
    expect(parsed.externalEventId).toBe("evt_1");
    expect(parsed.type).toBe("payment.succeeded");
  });

  it("rejects a valid digest with one extra hex nibble instead of letting Buffer.from truncate it", async () => {
    const provider = new FakeProvider();
    const payload = JSON.stringify({
      eventId: "evt_odd_nibble",
      providerPaymentId: "fake_odd_nibble",
      type: "payment.succeeded",
      amountCents: 1000,
    });
    const exact = signFakeWebhookPayload(payload);
    expect(exact).toHaveLength(64);

    const parsed = await provider.parseWebhook({
      rawBody: payload,
      headers: { "x-onlylive-fake-signature": `${exact}a` },
    });
    expect(parsed.signatureValid).toBe(false);
  });

  it("rejects a tampered payload / wrong signature", async () => {
    const provider = new FakeProvider();
    const payload = JSON.stringify({
      eventId: "evt_2",
      providerPaymentId: "fake_2",
      type: "payment.succeeded",
      amountCents: 1000,
    });
    const wrongSignature = signFakeWebhookPayload(payload + "tampered");
    const parsed = await provider.parseWebhook({
      rawBody: payload,
      headers: { "x-onlylive-fake-signature": wrongSignature },
    });
    expect(parsed.signatureValid).toBe(false);
  });

  it("rejects a missing signature header", async () => {
    const provider = new FakeProvider();
    const payload = JSON.stringify({
      eventId: "evt_3",
      providerPaymentId: "fake_3",
      type: "payment.succeeded",
      amountCents: 1000,
    });
    const parsed = await provider.parseWebhook({ rawBody: payload, headers: {} });
    expect(parsed.signatureValid).toBe(false);
  });
});
