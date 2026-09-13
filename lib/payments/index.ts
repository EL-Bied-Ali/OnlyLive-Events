import { FakeProvider } from "@/lib/payments/fakeProvider";
import type { PaymentProvider } from "@/lib/payments/provider";

export function getPaymentProvider(): PaymentProvider {
  const provider = process.env.PAYMENT_PROVIDER ?? "fake";
  switch (provider) {
    case "fake":
      return new FakeProvider();
    default:
      throw new Error(`Unknown PAYMENT_PROVIDER: ${provider}. Only "fake" is implemented so far.`);
  }
}
