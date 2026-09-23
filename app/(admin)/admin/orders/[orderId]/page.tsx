import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdminForPage } from "@/lib/auth/admin";
import { getOrderForAdmin } from "@/lib/admin/dashboard";
import { AdminMutationForm } from "../../events/AdminMutationForm";
import { refundPaymentAction } from "./actions";

type PageProps = { params: Promise<{ orderId: string }> };

const ORDER_LABELS: Record<string, string> = {
  pending_payment: "Paiement en attente",
  paid: "Payée",
  failed: "Échouée",
  cancelled: "Annulée",
  refunded: "Remboursée",
  partially_refunded: "Remboursement partiel",
  paid_but_unfulfillable: "Payée sans billet",
  reconciliation_required: "À réconcilier",
};

const TICKET_LABELS: Record<string, string> = {
  valid: "Valide",
  used: "Utilisé",
  cancelled: "Annulé",
};

function money(cents: number, currency = "MAD") {
  return new Intl.NumberFormat("fr-MA", { style: "currency", currency }).format(cents / 100);
}

export default async function AdminOrderDetailPage({ params }: PageProps) {
  const { orderId } = await params;
  const [admin, order] = await Promise.all([requireAdminForPage(), getOrderForAdmin(orderId)]);
  if (!order) notFound();

  const canRefund = admin.role === "super_admin" || admin.role === "admin";

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div>
          <p className="admin-eyebrow">Commande</p>
          <h1><code>{order.orderNumber}</code></h1>
        </div>
        <Link className="admin-secondary-link" href="/admin/orders">Retour aux commandes</Link>
      </header>

      <section className="admin-panel admin-form-panel">
        <h2>{order.event.title}</h2>
        <p className="admin-muted">
          <strong>{order.user.name}</strong> · {order.user.email}
          {order.user.phone ? ` · ${order.user.phone}` : ""}
        </p>
        <p>
          <span className={`admin-status admin-status-${order.status}`}>{ORDER_LABELS[order.status] ?? order.status}</span>
          {" "}Total : {money(order.totalAmountCents, order.currency)}
        </p>
      </section>

      <section className="admin-panel">
        <div className="admin-panel-title"><h2>Billets</h2></div>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead><tr><th>Catégorie</th><th>Jeton</th><th>Statut</th></tr></thead>
            <tbody>
              {order.items.flatMap((item) =>
                item.tickets.map((ticket) => (
                  <tr key={ticket.id}>
                    <td>{item.ticketCategory.name}</td>
                    <td><code>{ticket.validationToken.slice(0, 12)}…</code></td>
                    <td><span className={`admin-status admin-status-${ticket.status === "valid" ? "on_sale" : ticket.status === "used" ? "pending_payment" : "cancelled"}`}>{TICKET_LABELS[ticket.status] ?? ticket.status}</span></td>
                  </tr>
                )),
              )}
              {order.items.every((item) => item.tickets.length === 0) && (
                <tr><td colSpan={3} className="admin-empty">Aucun billet généré pour cette commande.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <section className="admin-panel">
        <div className="admin-panel-title"><h2>Paiements et remboursements</h2></div>
        <div className="admin-order-payments">
          {order.payments.map((payment) => {
            const refundableStatus = payment.status === "paid" || payment.status === "partially_refunded";
            const pendingRefundCents = payment.committedRefundCents - payment.refundedCents;
            return (
              <article key={payment.id} className="admin-payment-card">
                <header>
                  <div>
                    <strong>{money(payment.amountCents, payment.currency)}</strong>
                    <span className="admin-muted"> via {payment.provider}</span>
                  </div>
                  <span className={`admin-status admin-status-${payment.status}`}>{ORDER_LABELS[payment.status] ?? payment.status}</span>
                </header>

                {(payment.refundedCents > 0 || payment.committedRefundCents > 0) && (
                  <p className="admin-muted">
                    {money(payment.refundedCents, payment.currency)} confirmé remboursé
                    {pendingRefundCents > 0 ? ` · ${money(pendingRefundCents, payment.currency)} en attente provider` : ""}
                    {" · "}reste disponible : {money(payment.remainingRefundableCents, payment.currency)}
                  </p>
                )}

                {payment.refunds.length > 0 && (
                  <ul className="admin-refund-history">
                    {payment.refunds.map((refund) => (
                      <li key={refund.id}>
                        {money(refund.amountCents, payment.currency)} — {refund.status} — {refund.reason}
                      </li>
                    ))}
                  </ul>
                )}

                {canRefund && refundableStatus && payment.remainingRefundableCents > 0 && (
                  <AdminMutationForm action={refundPaymentAction} submitLabel="Rembourser" className="admin-edit-form">
                    <input name="paymentId" type="hidden" value={payment.id} />
                    <label>
                      Montant (MAD)
                      <input
                        name="amountCents"
                        required
                        inputMode="decimal"
                        placeholder={(payment.remainingRefundableCents / 100).toFixed(2)}
                        defaultValue={(payment.remainingRefundableCents / 100).toFixed(2)}
                      />
                    </label>
                    <label className="admin-field-wide">
                      Motif
                      <input name="reason" required minLength={3} maxLength={500} placeholder="Annulation client" />
                    </label>
                  </AdminMutationForm>
                )}
              </article>
            );
          })}
          {order.payments.length === 0 && <p className="admin-empty">Aucun paiement pour cette commande.</p>}
        </div>
      </section>
    </main>
  );
}
