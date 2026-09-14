import { ChariPayProvider } from "@/lib/payments/chariPayProvider";
import { FakeProvider } from "@/lib/payments/fakeProvider";
import type { PaymentProvider } from "@/lib/payments/provider";

/**
 * The fake/sandbox provider must be impossible to enable accidentally in
 * production. By default it is blocked whenever NODE_ENV === "production";
 * the only way to allow it there is an explicit, deliberate opt-in.
 */
export function isFakePaymentsAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.ALLOW_FAKE_PAYMENTS_IN_PRODUCTION === "true";
}

export function assertChariPayConfiguration(): void {
  const apiKey = process.env.CHARIPAY_API_KEY?.trim();
  const webhookSecret = process.env.CHARIPAY_WEBHOOK_SECRET?.trim();

  if (!apiKey) throw new Error("CHARIPAY_API_KEY is required when PAYMENT_PROVIDER=charipay");
  if (!apiKey.startsWith("chari_sk_test_") && !apiKey.startsWith("chari_sk_live_")) {
    throw new Error("CHARIPAY_API_KEY must be a documented ChariPay test or live secret key");
  }
  if (!webhookSecret) throw new Error("CHARIPAY_WEBHOOK_SECRET is required when PAYMENT_PROVIDER=charipay");

  if (
    process.env.NODE_ENV === "production" &&
    apiKey.startsWith("chari_sk_test_") &&
    process.env.ALLOW_CHARIPAY_TEST_KEY_IN_PRODUCTION !== "true"
  ) {
    throw new Error(
      "A ChariPay sandbox key cannot be used in production unless ALLOW_CHARIPAY_TEST_KEY_IN_PRODUCTION=true is explicitly set for a non-customer staging deployment.",
    );
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
      assertChariPayConfiguration();
      return new ChariPayProvider();
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}. Supported values: "fake", "charipay".`);
  }
}
