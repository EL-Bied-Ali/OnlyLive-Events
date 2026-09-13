import { notFound } from "next/navigation";
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
    <main style={{ maxWidth: 480, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 24, marginBottom: 8 }}>Paiement (bac à sable)</h1>
      <p style={{ opacity: 0.7, marginBottom: 24 }}>
        Aucun prestataire de paiement réel n&apos;est encore branché. Cette page simule une caisse
        hébergée par un PSP.
      </p>
      <div style={{ border: "1px solid #333", borderRadius: 12, padding: 20, marginBottom: 24 }}>
        <p style={{ margin: "0 0 4px" }}>{payment.order.event.title}</p>
        <p style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>
          {(payment.amountCents / 100).toFixed(2)} {payment.currency}
        </p>
      </div>
      <PayFakeClient paymentId={payment.id} />
    </main>
  );
}
