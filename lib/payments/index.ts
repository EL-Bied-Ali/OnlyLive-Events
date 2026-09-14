import { ChariPayProvider } from "@/lib/payments/charipayProvider";
import { FakeProvider } from "@/lib/payments/fakeProvider";
import type { PaymentProvider } from "@/lib/payments/provider";

export type ChariPayEnvironment = "sandbox" | "live";

export function isFakePaymentsAllowed(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.ALLOW_FAKE_PAYMENTS_IN_PRODUCTION === "true";
}

export function getOnlyLivePublicUrl(): string {
  const value = process.env.ONLYLIVE_PUBLIC_URL?.trim();
  if (!value) throw new Error("PAYMENT_PROVIDER=charipay requires ONLYLIVE_PUBLIC_URL");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("ONLYLIVE_PUBLIC_URL must be a valid absolute HTTPS URL");
  }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.search || url.hash) {
    throw new Error("ONLYLIVE_PUBLIC_URL must use HTTPS on the default port without credentials, query, or fragment");
  }
  if (url.pathname !== "/") {
    throw new Error("ONLYLIVE_PUBLIC_URL must be an origin only (no path)");
  }
  return url.origin;
}

export function getChariPayEnvironment(): ChariPayEnvironment {
  const value = process.env.CHARIPAY_ENV?.trim();
  if (value !== "sandbox" && value !== "live") {
    throw new Error('PAYMENT_PROVIDER=charipay requires CHARIPAY_ENV="sandbox" or "live"');
  }
  return value;
}

function assertChariPayConfig(): void {
  const apiKey = process.env.CHARIPAY_API_KEY?.trim();
  const webhookSecret = process.env.CHARIPAY_WEBHOOK_SECRET?.trim();
  if (!apiKey) throw new Error("PAYMENT_PROVIDER=charipay requires CHARIPAY_API_KEY");
  if (!webhookSecret) throw new Error("PAYMENT_PROVIDER=charipay requires CHARIPAY_WEBHOOK_SECRET");

  const providerEnv = getChariPayEnvironment();
  const vercelEnv = process.env.VERCEL_ENV?.trim();

  if (providerEnv === "sandbox" && !apiKey.startsWith("chari_sk_test_")) {
    throw new Error("CHARIPAY_ENV=sandbox requires a chari_sk_test_ API key");
  }
  if (providerEnv === "live" && !apiKey.startsWith("chari_sk_live_")) {
    throw new Error("CHARIPAY_ENV=live requires a chari_sk_live_ API key");
  }

  // Vercel Preview and Development builds are production-optimized Node
  // processes too, so NODE_ENV cannot distinguish them from customer traffic.
  // VERCEL_ENV is the deployment boundary; outside Vercel we fail safe by
  // allowing sandbox only.
  if (vercelEnv === "production") {
    if (providerEnv !== "live") {
      throw new Error("Vercel Production requires CHARIPAY_ENV=live");
    }
    if (process.env.CHARIPAY_PROVIDER_VERIFIED !== "true") {
      throw new Error("Live ChariPay is gated until sandbox verification: set CHARIPAY_PROVIDER_VERIFIED=true only after provider verification");
    }
    const cronSecret = process.env.CRON_SECRET?.trim();
    if (!cronSecret || cronSecret.length < 16) {
      throw new Error("Vercel Production ChariPay requires CRON_SECRET (16+ chars) for refund reconciliation");
    }
  } else if (providerEnv !== "sandbox") {
    throw new Error("ChariPay live credentials are forbidden outside Vercel Production");
  }

  getOnlyLivePublicUrl();
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
