import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { FakeProvider } from "@/lib/payments/fakeProvider";
import type { PaymentProvider } from "@/lib/payments/provider";

export function isFakePaymentsAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.ALLOW_FAKE_PAYMENTS_IN_PRODUCTION === "true";
}

function assertChariPayConfig(): void {
  const apiKey = process.env.CHARIPAY_API_KEY?.trim();
  const webhookSecret = process.env.CHARIPAY_WEBHOOK_SECRET?.trim();
  if (!apiKey) throw new Error("PAYMENT_PROVIDER=charipay requires CHARIPAY_API_KEY");
  if (!webhookSecret) throw new Error("PAYMENT_PROVIDER=charipay requires CHARIPAY_WEBHOOK_SECRET");

  if (process.env.NODE_ENV === "production" && !apiKey.startsWith("chari_sk_live_")) {
    throw new Error("Production ChariPay configuration requires a chari_sk_live_ API key");
  }
  if (process.env.NODE_ENV !== "production" && !apiKey.startsWith("chari_sk_test_") && !apiKey.startsWith("chari_sk_live_")) {
    throw new Error("CHARIPAY_API_KEY must be a ChariPay test or live key");
  }
}

export function getPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER ?? "fake";

  if (provider === "fake" && !isFakePaymentsAllowed()) {
    throw new Error(
      'PAYMENT_PROVIDER=fake cannot be used in production. Configure a real PaymentProvider, or set ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true only for a deliberate non-production-traffic deployment — never for real customer traffic.',
    );
  }

  switch (provider) {
    case "fake":
      return new FakeProvider();
    case "charipay":
      assertChariPayConfig();
      return new ChariPayProvider();
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}. Supported values: "fake", "charipay".`);
  }
}
