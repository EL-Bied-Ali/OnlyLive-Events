import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { FakeProvider } from "@/lib/payments/fakeProvider";
import type { PaymentProvider } from "@/lib/payments/provider";

/**
 * The fake/sandbox provider must be impossible to enable accidentally in
 * production. By default it is blocked whenever NODE_ENV === "production";
 * the only way to allow it there is an explicit, deliberate opt-in
 * (ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true), intended for a genuinely
 * non-production-traffic staging deployment that happens to run with
 * NODE_ENV=production — never for real customer traffic.
 */
export function isFakePaymentsAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.ALLOW_FAKE_PAYMENTS_IN_PRODUCTION === "true";
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
      return new ChariPayProvider();
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}. Supported values: "fake", "charipay".`);
  }
}
