import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { ReserveForm } from "./ReserveForm";

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

  if (!event) {
    notFound();
  }

  const now = new Date();
  const salesAreOpen =
    event.status === "on_sale" && event.salesOpenAt <= now && event.salesCloseAt > now;
  const eventDay = new Intl.DateTimeFormat("fr-MA", { day: "2-digit" }).format(event.startsAt);
  const eventMonth = new Intl.DateTimeFormat("fr-MA", { month: "long" }).format(event.startsAt);
  const eventYear = new Intl.DateTimeFormat("fr-MA", { year: "numeric" }).format(event.startsAt);
  const eventTime = new Intl.DateTimeFormat("fr-MA", { hour: "2-digit", minute: "2-digit" }).format(event.startsAt);
  const openPrices = salesAreOpen
    ? event.ticketCategories.flatMap((category) =>
        category.salesPhases
          .filter((phase) => phase.startsAt <= now && (!phase.endsAt || phase.endsAt > now))
          .map((phase) => phase.priceCents),
      )
    : [];
  const fromPriceCents = openPrices.length > 0 ? Math.min(...openPrices) : null;
  const fromPrice =
    fromPriceCents === null
      ? null
      : new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 0 }).format(fromPriceCents / 100);

  return (
    <main className="live-event-page">
      <nav className="live-nav" aria-label="Navigation principale">
        <Link href="/" className="live-brand" aria-label="OnlyLive — accueil">
          <span className="live-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <Link href="/" className="live-back-link">← Tous les événements</Link>
      </nav>

      <section className="live-event-hero" aria-labelledby="event-title">
        <div className={`live-event-visual${event.coverImageUrl ? " has-cover" : ""}`} aria-hidden="true">
          {event.coverImageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- administrator-managed event artwork can be hosted on arbitrary approved origins.
            <img className="live-event-cover" src={event.coverImageUrl} alt="" />
          ) : null}
          <span className="live-stage-number">{eventDay}·{new Intl.DateTimeFormat("fr-MA", { month: "2-digit" }).format(event.startsAt)}</span>
          <span className="live-stage-ring" />
          <span className="live-stage-scanline" />
          <span className="live-stage-caption">{event.venue.city}<br />{eventYear}</span>
          <span className={`live-stage-status ${salesAreOpen ? "is-live" : ""}`}>
            {salesAreOpen
              ? "Billets en vente"
              : event.status === "sold_out"
                ? "Complet"
                : event.status === "cancelled"
                  ? "Annulé"
                  : "Hors vente"}
          </span>
        </div>
        <div className="live-event-hero-copy">
          <p className="live-kicker"><span aria-hidden="true" /> OnlyLive présente</p>
          <h1 id="event-title">{event.title}</h1>
          <p className="live-event-description">{event.description}</p>
          <dl className="live-event-facts">
            <div><dt>Date</dt><dd><strong>{eventDay} {eventMonth}</strong><span>{eventYear} · {eventTime}</span></dd></div>
            <div><dt>Lieu</dt><dd><strong>{event.venue.name}</strong><span>{event.venue.city}, Maroc</span></dd></div>
          </dl>
          <div className="live-hero-actions">
            {salesAreOpen && fromPrice ? (
              <a className="live-hero-ticket-cta" href="#tickets">
                <span>Choisir mes billets</span>
                <span aria-hidden="true">↘</span>
              </a>
            ) : (
              <div className="live-hero-ticket-cta is-disabled" aria-disabled="true">
                <span>
                  {event.status === "sold_out"
                    ? "Billetterie complète"
                    : event.status === "cancelled"
                      ? "Événement annulé"
                      : "Vente indisponible"}
                </span>
                <span aria-hidden="true">—</span>
              </div>
            )}
            <p className="live-hero-price">
              {fromPrice ? (
                <>
                  <small>À partir de</small>
                  <strong>{fromPrice} MAD</strong>
                </>
              ) : (
                <>
                  <small>Disponibilité</small>
                  <strong>
                    {event.status === "sold_out"
                      ? "Complet"
                      : event.status === "cancelled"
                        ? "Annulé"
                        : "Hors vente"}
                  </strong>
                </>
              )}
            </p>
          </div>
        </div>
      </section>

      {event.status === "cancelled" ? (
        <p role="alert" className="live-event-alert">
          Cet événement est annulé. Les détenteurs de billets seront contactés par OnlyLive.
        </p>
      ) : null}

      <section id="tickets" className="live-tickets" aria-labelledby="tickets-title">
        <div className="live-section-heading">
          <p>Choisissez votre expérience</p>
          <h2 id="tickets-title">Billets</h2>
        </div>
        <div className="live-ticket-list">
        {event.ticketCategories.map((category) => {
          const inventory = category.inventory;
          const available = inventory
            ? inventory.totalQuantity - inventory.reservedQuantity - inventory.soldQuantity
            : 0;
          const openPhase = salesAreOpen ? category.salesPhases.find(
            (phase) => phase.startsAt <= now && (!phase.endsAt || phase.endsAt > now),
          ) : undefined;

          return (
            <article key={category.id} className="live-ticket-card">
              <div className="live-ticket-main">
                <span className="live-ticket-notch" aria-hidden="true" />
                <span className="live-ticket-label">Accès</span>
                <h3>{category.name}</h3>
                {category.description ? <p>{category.description}</p> : <p>Accès officiel · Billet numérique sécurisé</p>}
                <span className="live-ticket-stock">{available > 0 ? `${available} places disponibles` : "Épuisé"}</span>
              </div>

              <div className="live-ticket-action">
              {!openPhase && event.status !== "cancelled" ? <p className="live-ticket-unavailable">Aucune vente ouverte pour le moment</p> : null}

              {openPhase && (
                <>
                  <p className="live-ticket-price">
                    <small>{openPhase.name}</small>
                    <strong>{new Intl.NumberFormat("fr-MA", { maximumFractionDigits: 0 }).format(openPhase.priceCents / 100)} <span>{openPhase.currency}</span></strong>
                  </p>
                  <ReserveForm
                    ticketCategoryId={category.id}
                    salesPhaseId={openPhase.id}
                    available={available}
                    maxPerOrder={event.maxTicketsPerUser}
                  />
                </>
              )}
              </div>
            </article>
          );
        })}
        </div>
        <p className="live-ticket-trust">Paiement hébergé et sécurisé · Billets émis uniquement après confirmation du prestataire</p>
      </section>
    </main>
  );
}
