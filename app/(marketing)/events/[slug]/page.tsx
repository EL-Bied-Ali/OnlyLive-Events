import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { ReserveForm } from "./ReserveForm";
import { formatCurrency } from "@/lib/formatCurrency";

export const dynamic = "force-dynamic";

export default async function EventPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const event = await prisma.event.findFirst({
    where: { slug, status: { not: "draft" } },
    include: {
      venue: true,
      ticketCategories: {
        where: { isActive: true },
        orderBy: { sortOrder: "asc" },
        include: {
          inventory: true,
          salesPhases: { where: { isActive: true }, orderBy: { sortOrder: "asc" } },
        },
      },
    },
  });

  if (!event) notFound();

  const now = new Date();
  const salesAreOpen =
    event.status === "on_sale" && event.salesOpenAt <= now && event.salesCloseAt > now;
  const eventDate = new Intl.DateTimeFormat("fr-MA", {
    dateStyle: "full",
    timeStyle: "short",
  }).format(event.startsAt);

  return (
    <main className="event-page">
      <header className="event-header">
        <Link href="/" className="customer-brand" aria-label="OnlyLive — accueil">
          <span className="customer-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <Link href="/" className="event-back-link">Tous les événements</Link>
      </header>

      <section className="event-hero">
        <span className="customer-summary-label">Événement</span>
        <h1>{event.title}</h1>
        <div className="event-meta">
          <span>{eventDate}</span>
          <span>{event.venue.name}, {event.venue.city}</span>
        </div>
        {event.description ? <p className="event-description">{event.description}</p> : null}
      </section>

      {event.status === "cancelled" ? (
        <div role="alert" className="customer-payment-alert customer-payment-alert-error event-alert">
          <strong>Événement annulé</strong>
          <p>Les détenteurs de billets seront contactés par OnlyLive.</p>
        </div>
      ) : null}

      <section className="event-tickets" aria-labelledby="ticket-options-title">
        <div className="marketing-section-heading">
          <div>
            <span className="customer-summary-label">Billetterie</span>
            <h2 id="ticket-options-title">Choisissez vos billets</h2>
          </div>
          {salesAreOpen ? <span>Vente ouverte</span> : null}
        </div>

        <div className="event-ticket-list">
          {event.ticketCategories.map((category) => {
            const inventory = category.inventory;
            const available = inventory
              ? inventory.totalQuantity - inventory.reservedQuantity - inventory.soldQuantity
              : 0;
            const openPhase = salesAreOpen ? category.salesPhases.find(
              (phase) => phase.startsAt <= now && (!phase.endsAt || phase.endsAt > now),
            ) : undefined;

            return (
              <article key={category.id} className="event-ticket-card">
                <div className="event-ticket-info">
                  <h3>{category.name}</h3>
                  {category.description ? <p>{category.description}</p> : null}
                  {openPhase ? (
                    <div className="event-ticket-price">
                      <strong>{formatCurrency(openPhase.priceCents, openPhase.currency)}</strong>
                      <span>{openPhase.name}</span>
                    </div>
                  ) : event.status !== "cancelled" ? (
                    <p className="event-ticket-unavailable">Aucune vente ouverte pour le moment.</p>
                  ) : null}
                </div>

                {openPhase ? (
                  <ReserveForm
                    ticketCategoryId={category.id}
                    salesPhaseId={openPhase.id}
                    available={available}
                    maxPerOrder={event.maxTicketsPerUser}
                  />
                ) : null}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
