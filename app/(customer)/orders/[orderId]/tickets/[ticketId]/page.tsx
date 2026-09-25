import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { renderTicketQrDataUrl } from "@/lib/tickets";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
}: {
  params: Promise<{ orderId: string; ticketId: string }>;
}) {
  const { orderId, ticketId } = await params;
  const customer = await requireCustomerForPage(`/orders/${orderId}/tickets/${ticketId}`);

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      event: { include: { venue: true } },
      ticketCategory: true,
      orderItem: { include: { order: true } },
    },
  });

  // The ownership check goes through the order, not the ticket directly —
  // a ticket has no user_id of its own by design.
  if (!ticket || ticket.orderItem.order.id !== orderId || ticket.orderItem.order.userId !== customer.id) {
    notFound();
  }

  // The QR's validity is decided atomically by the backend scanner — this
  // data URL is a rendering convenience only, never a source of truth for
  // admission.
  const qrDataUrl = await renderTicketQrDataUrl(ticket.validationToken);

  const STATUS_PRESENTATION: Record<string, { label: string; tone: string; guidance: string }> = {
    valid: {
      label: "Billet valide",
      tone: "valid",
      guidance: "Présentez ce QR code à l’entrée de l’événement.",
    },
    used: {
      label: "Billet déjà scanné",
      tone: "used",
      guidance: "Ce billet a déjà été enregistré par le contrôle d’accès.",
    },
    cancelled: {
      label: "Billet annulé",
      tone: "cancelled",
      guidance: "Ce billet n’est plus actif pour le contrôle d’accès.",
    },
  };

  const status =
    STATUS_PRESENTATION[ticket.status] ?? {
      label: ticket.status,
      tone: "neutral",
      guidance: "Le statut affiché correspond à l’état actuel du billet.",
    };
  const eventDate = new Intl.DateTimeFormat("fr-MA", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(ticket.event.startsAt);

  return (
    <main className="customer-ticket-page">
      <header className="customer-ticket-header">
        <Link href="/" className="customer-brand" aria-label="OnlyLive — accueil">
          <span className="customer-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <Link href={`/orders/${orderId}`} className="customer-ticket-back-link">
          Commande {ticket.orderItem.order.orderNumber}
        </Link>
      </header>

      <article className="customer-ticket-card">
        <div className="customer-ticket-event">
          <span className="customer-summary-label">Votre billet</span>
          <h1>{ticket.event.title}</h1>
          <p>{ticket.ticketCategory.name}</p>
        </div>

        <div className={`customer-ticket-status customer-ticket-status-${status.tone}`} role="status">
          <span className="customer-ticket-status-dot" aria-hidden="true" />
          <div>
            <strong>{status.label}</strong>
            <p>{status.guidance}</p>
          </div>
        </div>

        <div className={`customer-ticket-qr customer-ticket-qr-${status.tone}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- data URL, not an optimizable remote image */}
          <img src={qrDataUrl} alt="QR code du billet" />
        </div>

        <dl className="customer-ticket-details">
          <div>
            <dt>Date</dt>
            <dd>{eventDate}</dd>
          </div>
          <div>
            <dt>Lieu</dt>
            <dd>{ticket.event.venue.name}, {ticket.event.venue.city}</dd>
          </div>
          <div>
            <dt>Catégorie</dt>
            <dd>{ticket.ticketCategory.name}</dd>
          </div>
          <div>
            <dt>Référence</dt>
            <dd>{ticket.id}</dd>
          </div>
        </dl>
      </article>

      <footer className="customer-ticket-footer">
        <Link href={`/orders/${orderId}`}>Retour à la commande</Link>
        <p>La validation du billet est effectuée par le système de contrôle OnlyLive.</p>
      </footer>
    </main>
  );
}
