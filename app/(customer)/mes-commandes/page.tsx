import Link from "next/link";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { prisma } from "@/lib/db";
import { CustomerNav } from "@/components/CustomerNav";
import { formatCurrency } from "@/lib/formatCurrency";
import { formatEventDateOnly } from "@/lib/formatEventDate";

export const dynamic = "force-dynamic";

const STATUS_PRESENTATION: Record<string, { label: string; tone: string }> = {
  pending_payment: { label: "En attente", tone: "pending" },
  paid: { label: "Payée", tone: "success" },
  failed: { label: "Paiement échoué", tone: "danger" },
  cancelled: { label: "Annulée", tone: "neutral" },
  refunded: { label: "Remboursée", tone: "neutral" },
  partially_refunded: { label: "Partiellement remboursée", tone: "attention" },
  paid_but_unfulfillable: { label: "Vérification en cours", tone: "attention" },
  reconciliation_required: { label: "Vérification en cours", tone: "attention" },
};

type OrderRow = Awaited<ReturnType<typeof loadOrders>>[number];

async function loadOrders(userId: string) {
  const orders = await prisma.order.findMany({
    where: { userId },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      currency: true,
      totalAmountCents: true,
      createdAt: true,
      event: { select: { title: true, slug: true } },
      payments: { select: { refunds: { select: { status: true, amountCents: true } } } },
    },
    orderBy: { createdAt: "desc" },
  });

  return orders.map((order) => {
    const refunds = order.payments.flatMap((payment) => payment.refunds);
    const succeededRefundCents = refunds
      .filter((refund) => refund.status === "succeeded")
      .reduce((sum, refund) => sum + refund.amountCents, 0);
    const refundPending = refunds.some((refund) => refund.status === "pending" || refund.status === "processing");
    return { ...order, succeededRefundCents, refundPending };
  });
}

function OrderRowCard({ order }: { order: OrderRow }) {
  const presentation = STATUS_PRESENTATION[order.status] ?? { label: order.status, tone: "neutral" };
  const purchaseDate = formatEventDateOnly(order.createdAt, "long");
  const total = formatCurrency(order.totalAmountCents, order.currency);

  return (
    <Link href={`/orders/${order.id}`} className={`customer-order-row customer-order-row-${presentation.tone}`}>
      <div className="customer-order-row-main">
        <span className="customer-order-row-number">Commande {order.orderNumber}</span>
        <strong>{order.event.title}</strong>
        <span className="customer-order-row-date">{purchaseDate}</span>
      </div>

      <div className="customer-order-row-amount">
        <strong>{total}</strong>
        {order.succeededRefundCents > 0 && (
          <span className="customer-order-row-refund">
            Remboursé : {formatCurrency(order.succeededRefundCents, order.currency)}
          </span>
        )}
        {order.refundPending && <span className="customer-order-row-refund">Remboursement en cours</span>}
      </div>

      <div className={`customer-order-row-status customer-order-row-status-${presentation.tone}`}>
        <span className="customer-order-row-status-dot" aria-hidden="true" />
        {presentation.label}
      </div>
    </Link>
  );
}

export default async function MesCommandesPage() {
  const customer = await requireCustomerForPage("/mes-commandes");
  const orders = await loadOrders(customer.id);

  return (
    <main className="customer-orders-page">
      <CustomerNav />

      <div className="customer-orders-heading">
        <h1>Mes commandes</h1>
        <p>L’historique de vos achats OnlyLive, avec le statut de paiement et de remboursement.</p>
      </div>

      {orders.length === 0 ? (
        <div className="customer-wallet-empty">
          <p>Vous n’avez pas encore de commande.</p>
          <Link href="/" className="customer-primary-button customer-wallet-empty-cta">
            Découvrir les événements
          </Link>
        </div>
      ) : (
        <section aria-label="Historique des commandes" className="customer-orders-list">
          {orders.map((order) => (
            <OrderRowCard key={order.id} order={order} />
          ))}
        </section>
      )}
    </main>
  );
}
