import Link from "next/link";
import { getAdminOverview } from "@/lib/admin/dashboard";

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

function money(cents: number) {
  return new Intl.NumberFormat("fr-MA", { style: "currency", currency: "MAD" }).format(cents / 100);
}

export default async function AdminDashboardPage() {
  const { metrics, recentOrders, events } = await getAdminOverview();

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div>
          <p className="admin-eyebrow">Pilotage</p>
          <h1>Vue d’ensemble</h1>
        </div>
        <p className="admin-date">{new Intl.DateTimeFormat("fr-MA", { dateStyle: "long" }).format(new Date())}</p>
      </header>

      {metrics.attentionOrders > 0 && (
        <Link className="admin-alert" href="/admin/orders">
          <strong>{metrics.attentionOrders} commande(s) nécessitent une intervention</strong>
          <span>Consulter les paiements concernés →</span>
        </Link>
      )}

      <section className="admin-metrics" aria-label="Indicateurs principaux">
        <article><span>Encaissements confirmés</span><strong>{money(metrics.grossCapturedCents)}</strong></article>
        <article><span>Billets générés</span><strong>{metrics.ticketsSold.toLocaleString("fr-MA")}</strong></article>
        <article><span>Entrées validées</span><strong>{metrics.checkIns.toLocaleString("fr-MA")}</strong></article>
        <article><span>Paiements en attente</span><strong>{metrics.awaitingPayment.toLocaleString("fr-MA")}</strong></article>
      </section>

      <div className="admin-dashboard-grid">
        <section className="admin-panel admin-panel-wide">
          <div className="admin-panel-title">
            <div><p className="admin-eyebrow">Activité récente</p><h2>Dernières commandes</h2></div>
            <Link href="/admin/orders">Tout voir</Link>
          </div>
          <div className="admin-table-wrap">
            <table className="admin-table">
              <thead><tr><th>Commande</th><th>Client</th><th>Événement</th><th>Montant</th><th>Statut</th></tr></thead>
              <tbody>
                {recentOrders.map((order) => (
                  <tr key={order.id}>
                    <td><code>{order.orderNumber}</code></td>
                    <td><strong>{order.user.name}</strong><small>{order.user.email}</small></td>
                    <td>{order.event.title}</td>
                    <td>{money(order.totalAmountCents)}</td>
                    <td><span className={`admin-status admin-status-${order.status}`}>{ORDER_LABELS[order.status] ?? order.status}</span></td>
                  </tr>
                ))}
                {recentOrders.length === 0 && <tr><td colSpan={5} className="admin-empty">Aucune commande pour le moment.</td></tr>}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-panel">
          <div className="admin-panel-title"><div><p className="admin-eyebrow">Catalogue</p><h2>Événements</h2></div><Link href="/admin/events">Détails</Link></div>
          <div className="admin-event-list">
            {events.slice(0, 4).map((event) => {
              const inventory = event.ticketCategories.reduce((acc, category) => ({
                total: acc.total + (category.inventory?.totalQuantity ?? 0),
                sold: acc.sold + (category.inventory?.soldQuantity ?? 0),
              }), { total: 0, sold: 0 });
              const progress = inventory.total ? Math.round((inventory.sold / inventory.total) * 100) : 0;
              return (
                <article key={event.id}>
                  <div><strong>{event.title}</strong><span>{event.venue.city} · {new Intl.DateTimeFormat("fr-MA", { dateStyle: "medium" }).format(event.startsAt)}</span></div>
                  <div className="admin-progress"><i style={{ width: `${progress}%` }} /><span>{inventory.sold}/{inventory.total}</span></div>
                </article>
              );
            })}
            {events.length === 0 && <p className="admin-empty">Aucun événement.</p>}
          </div>
        </section>
      </div>
    </main>
  );
}
