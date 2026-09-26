import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { OrderStatusAutoRefresh } from "./OrderStatusAutoRefresh";
import { formatCurrency } from "@/lib/formatCurrency";
import { formatEventDate } from "@/lib/formatEventDate";
import { CustomerNav } from "@/components/CustomerNav";

export const dynamic = "force-dynamic";

type StatusTone = "pending" | "success" | "danger" | "neutral" | "attention";

interface StatusPresentation {
  tone: StatusTone;
  eyebrow: string;
  title: string;
  description: string;
  guidance?: string;
}

const STATUS_PRESENTATIONS: Record<string, StatusPresentation> = {
  pending_payment: {
    tone: "pending",
    eyebrow: "Vérification du paiement",
    title: "Confirmation en cours",
    description:
      "Nous vérifions le paiement auprès du prestataire. Le retour depuis la page de paiement ne suffit pas, à lui seul, à confirmer la commande.",
    guidance: "Ne relancez pas un second paiement pendant cette vérification.",
  },
  paid: {
    tone: "success",
    eyebrow: "Commande confirmée",
    title: "Paiement confirmé",
    description: "Votre commande est confirmée et vos billets sont disponibles ci-dessous.",
  },
  failed: {
    tone: "danger",
    eyebrow: "Paiement non confirmé",
    title: "Le paiement n’a pas abouti",
    description:
      "Aucun billet n’a été émis pour cette commande. Si vous revenez tout juste du paiement et pensez avoir été débité, actualisez d’abord cette page avant toute nouvelle tentative.",
    guidance: "Évitez de repayer tant que vous avez un doute sur le premier paiement.",
  },
  cancelled: {
    tone: "neutral",
    eyebrow: "Commande annulée",
    title: "Cette commande n’est plus active",
    description: "Aucun billet actif n’est associé à cette commande.",
  },
  refunded: {
    tone: "neutral",
    eyebrow: "Remboursement",
    title: "Commande remboursée",
    description: "Le remboursement de cette commande a été enregistré.",
  },
  partially_refunded: {
    tone: "attention",
    eyebrow: "Remboursement partiel",
    title: "Commande partiellement remboursée",
    description: "Une partie du montant de cette commande a été remboursée.",
  },
  paid_but_unfulfillable: {
    tone: "attention",
    eyebrow: "Paiement reçu",
    title: "Traitement manuel en cours",
    description:
      "Le paiement a été reçu, mais la commande nécessite une intervention avant que les billets puissent être émis.",
    guidance: "Ne payez pas une seconde fois : cette commande est déjà liée à un paiement reçu.",
  },
  reconciliation_required: {
    tone: "attention",
    eyebrow: "Paiement reçu",
    title: "Vérification supplémentaire en cours",
    description:
      "Le paiement a été reçu et doit être rapproché avant que la commande puisse être finalisée.",
    guidance: "Ne payez pas une seconde fois pendant cette vérification.",
  },
};

const REFRESHABLE_STATUSES = new Set(["pending_payment", "paid_but_unfulfillable", "reconciliation_required"]);

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const customer = await requireCustomerForPage(`/orders/${orderId}`);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      event: { include: { venue: true } },
      items: {
        include: {
          ticketCategory: true,
          tickets: true,
        },
      },
    },
  });

  if (!order || order.userId !== customer.id) {
    notFound();
  }

  const refreshable = REFRESHABLE_STATUSES.has(order.status);
  const tickets = order.items.flatMap((item) => item.tickets);
  const basePresentation =
    STATUS_PRESENTATIONS[order.status] ?? {
      tone: "neutral" as const,
      eyebrow: "Statut de la commande",
      title: order.status,
      description: "Le statut de cette commande est affiché tel qu’il est enregistré.",
    };
  const presentation =
    order.status === "paid" && tickets.length === 0
      ? {
          ...basePresentation,
          description: "Votre commande est confirmée. Vos billets sont encore en cours de préparation.",
        }
      : basePresentation;
  const total = formatCurrency(order.totalAmountCents, order.currency);
  const primaryTicket = tickets.length === 1 ? tickets[0] : null;
  const eventDate = formatEventDate(order.event.startsAt);

  return (
    <main className="customer-order-page">
      <CustomerNav trailing={<span className="customer-order-number">Commande {order.orderNumber}</span>} />

      <OrderStatusAutoRefresh orderId={order.id} status={order.status} />

      <section className={`customer-order-status customer-order-status-${presentation.tone}`} aria-live="polite">
        <span className="customer-status-symbol" aria-hidden="true">
          {presentation.tone === "success"
            ? "✓"
            : presentation.tone === "danger"
              ? "!"
              : presentation.tone === "neutral"
                ? "—"
                : "···"}
        </span>
        <div>
          <p className="customer-status-eyebrow">{presentation.eyebrow}</p>
          <h1>{presentation.title}</h1>
          <p>{presentation.description}</p>
          {presentation.guidance ? <strong>{presentation.guidance}</strong> : null}
          {refreshable ? (
            <small>Cette page se met à jour automatiquement pendant la vérification.</small>
          ) : null}
          {order.status === "paid" && primaryTicket ? (
            <Link className="customer-status-primary-action" href={`/orders/${order.id}/tickets/${primaryTicket.id}`}>
              Afficher mon billet
            </Link>
          ) : order.status === "paid" && tickets.length > 1 ? (
            <a className="customer-status-primary-action" href="#order-items-title">
              Voir mes {tickets.length} billets
            </a>
          ) : null}
        </div>
      </section>

      <section className="customer-order-event">
        <div>
          <span className="customer-summary-label">Événement</span>
          <h2>{order.event.title}</h2>
          <p>{eventDate}</p>
          <p>{order.event.venue.name}, {order.event.venue.city}</p>
        </div>
        <div className="customer-order-total">
          <span>Total</span>
          <strong>{total}</strong>
        </div>
      </section>

      <section className="customer-order-items" aria-labelledby="order-items-title">
        <div className="customer-section-heading">
          <div>
            <span className="customer-summary-label">Détail</span>
            <h2 id="order-items-title">Vos billets</h2>
          </div>
          <span>{order.items.reduce((sum, item) => sum + item.quantity, 0)} billet(s)</span>
        </div>

        <div className="customer-order-item-list">
          {order.items.map((item) => (
            <article key={item.id} className="customer-order-item">
              <div className="customer-order-item-heading">
                <div>
                  <strong>{item.ticketCategory.name}</strong>
                  <span>{item.quantity} × {formatCurrency(item.unitPriceCents, order.currency)}</span>
                </div>
                <strong>{formatCurrency(item.quantity * item.unitPriceCents, order.currency)}</strong>
              </div>

              {item.tickets.length > 0 ? (
                <div className="customer-ticket-links">
                  {item.tickets.map((ticket, index) => (
                    <Link key={ticket.id} href={`/orders/${order.id}/tickets/${ticket.id}`}>
                      Voir le billet {item.tickets.length > 1 ? index + 1 : ""}
                    </Link>
                  ))}
                </div>
              ) : (
                <p className="customer-ticket-pending">
                  {order.status === "paid"
                    ? "Les billets sont en cours de préparation. Actualisez cette page si nécessaire."
                    : "Les billets apparaîtront ici après confirmation et finalisation de la commande."}
                </p>
              )}
            </article>
          ))}
        </div>
      </section>

      <footer className="customer-order-footer">
        <Link href={`/events/${order.event.slug}`}>Retour à l’événement</Link>
        <p>Conservez le numéro {order.orderNumber} si vous devez faire référence à cette commande.</p>
      </footer>
    </main>
  );
}
