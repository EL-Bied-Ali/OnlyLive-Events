import { notFound } from "next/navigation";
import Link from "next/link";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { getPaymentForFakeCheckoutPage } from "@/lib/orders/checkout";
import { isFakePaymentsAllowed } from "@/lib/payments";
import { PayFakeClient } from "./PayFakeClient";

export const dynamic = "force-dynamic";

export default async function PayFakePage({ params }: { params: Promise<{ paymentId: string }> }) {
  if (!isFakePaymentsAllowed()) {
    notFound();
  }

  const { paymentId } = await params;
  const customer = await requireCustomerForPage(`/pay/fake/${paymentId}`);

  const payment = await getPaymentForFakeCheckoutPage(paymentId).catch(() => null);
  if (!payment || payment.order.userId !== customer.id) {
    notFound();
  }

  return (
    <main className="fake-payment-page">
      <Link href="/" className="live-brand" aria-label="OnlyLive — accueil">
        <span className="live-brand-mark" aria-hidden="true">OL</span><span>OnlyLive</span>
      </Link>
      <section className="fake-payment-card">
      <p className="fake-payment-badge">Environnement de démonstration</p>
      <h1>Paiement test</h1>
      <p className="fake-payment-intro">
        Aucun prestataire de paiement réel n&apos;est encore branché. Cette page simule une caisse
        hébergée par un PSP.
      </p>
      <div className="fake-payment-summary">
        <p>{payment.order.event.title}</p>
        <strong>{new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 2 }).format(payment.amountCents / 100)} {payment.currency}</strong>
      </div>
      <PayFakeClient paymentId={payment.id} />
      <p className="fake-payment-note">Aucune carte ni somme réelle n’est utilisée sur cet écran.</p>
      </section>
    </main>
  );
}
