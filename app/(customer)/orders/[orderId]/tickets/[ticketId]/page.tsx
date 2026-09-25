import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { renderTicketQrDataUrl } from "@/lib/tickets";
import { formatEventDate } from "@/lib/formatEventDate";
import { CustomerNav } from "@/components/CustomerNav";

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

  if (!ticket || ticket.orderItem.order.id !== orderId || ticket.orderItem.order.userId !== customer.id) {
    notFound();
  }

  const qrDataUrl =
    ticket.status === "valid" ? await renderTicketQrDataUrl(ticket.validationToken) : null;

  const STATUS_PRESENTATIONS: Record<string, { label: string; guidance: string }> = {
    valid: {
      label: "Billet valide",
      guidance: "Présentez ce QR code au contrôle d’accès. Augmentez la luminosité de votre écran pour faciliter le scan.",
    },
    used: {
      label: "Billet déjà scanné",
      guidance: "Ce billet a déjà été utilisé à l’entrée et ne peut pas être présenté une seconde fois.",
    },
    cancelled: {
      label: "Billet annulé",
      guidance: "Ce billet n’est plus valide et son QR code ne permet plus l’accès à l’événement.",
    },
  };
  const status = STATUS_PRESENTATIONS[ticket.status] ?? {
    label: ticket.status,
    guidance: "Le statut de ce billet est affiché tel qu’il est enregistré.",
  };
  const eventDate = formatEventDate(ticket.event.startsAt);
  const shortTicketId = ticket.id.slice(-8).toUpperCase();

  return (
    <main className={`customer-ticket-page customer-ticket-${ticket.status}`}>
      <CustomerNav
        trailing={
          <Link href={`/orders/${orderId}`} className="customer-ticket-back">
            ← Commande {ticket.orderItem.order.orderNumber}
          </Link>
        }
      />

      <section className="customer-ticket-intro" aria-labelledby="ticket-title">
        <p className="customer-status-eyebrow">Votre accès</p>
        <h1 id="ticket-title">Prêt pour le live.</h1>
        <p>Gardez ce billet accessible à l’entrée, même si le réseau mobile est saturé.</p>
      </section>

      <article className="customer-ticket-pass">
        <div className="customer-ticket-details">
          <div className={`customer-ticket-state customer-ticket-state-${ticket.status}`} role="status">
            <span aria-hidden="true">{ticket.status === "valid" ? "✓" : ticket.status === "used" ? "···" : "!"}</span>
            <strong>{status.label}</strong>
          </div>

          <div className="customer-ticket-event-copy">
            <span>OnlyLive présente</span>
            <h2>{ticket.event.title}</h2>
          </div>

          <dl className="customer-ticket-facts">
            <div><dt>Catégorie</dt><dd>{ticket.ticketCategory.name}</dd></div>
            <div><dt>Date</dt><dd>{eventDate}</dd></div>
            <div><dt>Lieu</dt><dd>{ticket.event.venue.name}<span>{ticket.event.venue.city}, Maroc</span></dd></div>
            <div><dt>Référence billet</dt><dd>OL-{shortTicketId}</dd></div>
          </dl>
        </div>

        <div className="customer-ticket-code">
          <span className="customer-ticket-notch" aria-hidden="true" />
          {qrDataUrl ? (
            <div className="customer-ticket-qr">
              {/* eslint-disable-next-line @next/next/no-img-element -- data URL, not an optimizable remote image */}
              <img src={qrDataUrl} alt="QR code du billet" />
            </div>
          ) : (
            <div className="customer-ticket-code-disabled" aria-hidden="true">
              <span>{ticket.status === "used" ? "UTILISÉ" : "ANNULÉ"}</span>
            </div>
          )}
          <p>{status.guidance}</p>
        </div>
      </article>

      <footer className="customer-ticket-footer">
        <p>Le contrôle d’accès vérifie ce billet en temps réel. Une capture ou une copie ne crée pas de second accès.</p>
        <Link href={`/orders/${orderId}`}>Voir la commande</Link>
      </footer>
    </main>
  );
}
