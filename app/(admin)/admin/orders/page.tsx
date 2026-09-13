import Link from "next/link";
import { getAdminOrders, isOrderStatus } from "@/lib/admin/dashboard";

const FILTERS = [
  ["", "Toutes"],
  ["pending_payment", "En attente"],
  ["paid", "Payées"],
  ["failed", "Échouées"],
  ["cancelled", "Annulées"],
  ["reconciliation_required", "À réconcilier"],
  ["paid_but_unfulfillable", "Sans billet"],
] as const;

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

function money(cents: number, currency: string) {
  return new Intl.NumberFormat("fr-MA", { style: "currency", currency }).format(cents / 100);
}

export default async function AdminOrdersPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status: rawStatus } = await searchParams;
  const status = isOrderStatus(rawStatus) ? rawStatus : undefined;
  const orders = await getAdminOrders(status);

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div><p className="admin-eyebrow">Clients et paiements</p><h1>Commandes</h1></div>
        <span className="admin-count">{orders.length} résultat(s)</span>
      </header>

      <nav className="admin-filters" aria-label="Filtrer les commandes">
        {FILTERS.map(([value, label]) => (
          <Link key={value} className={(status ?? "") === value ? "active" : ""} href={value ? `/admin/orders?status=${value}` : "/admin/orders"}>{label}</Link>
        ))}
      </nav>

      <section className="admin-panel">
        <div className="admin-table-wrap">
          <table className="admin-table admin-orders-table">
            <thead><tr><th>Commande</th><th>Client</th><th>Billets</th><th>Paiement</th><th>Total</th><th>Créée le</th></tr></thead>
            <tbody>
              {orders.map((order) => {
                const payment = order.payments[0];
                return (
                  <tr key={order.id}>
                    <td><code>{order.orderNumber}</code><small>{order.event.title}</small></td>
                    <td><strong>{order.user.name}</strong><small>{order.user.email}{order.user.phone ? ` · ${order.user.phone}` : ""}</small></td>
                    <td>{order.items.map((item) => `${item.quantity}× ${item.ticketCategory.name}`).join(", ")}</td>
                    <td><span className={`admin-status admin-status-${order.status}`}>{ORDER_LABELS[order.status] ?? order.status}</span><small>{payment?.provider ?? "—"}</small></td>
                    <td>{money(order.totalAmountCents, order.currency)}</td>
                    <td>{new Intl.DateTimeFormat("fr-MA", { dateStyle: "medium", timeStyle: "short" }).format(order.createdAt)}</td>
                  </tr>
                );
              })}
              {orders.length === 0 && <tr><td colSpan={6} className="admin-empty">Aucune commande pour ce filtre.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
