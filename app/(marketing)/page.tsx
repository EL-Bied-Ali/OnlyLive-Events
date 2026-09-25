import Link from "next/link";
import { prisma } from "@/lib/db";
import { legalDocumentsApproved } from "@/lib/legal/approval";
import { formatEventDateOnly, formatEventDay, formatEventMonth } from "@/lib/formatEventDate";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const events = await prisma.event.findMany({
    where: { status: { in: ["published", "on_sale", "sold_out"] } },
    include: { venue: true },
    orderBy: { startsAt: "asc" },
  });

  return (
    <main className="marketing-page">
      <header className="marketing-header">
        <Link href="/" className="customer-brand" aria-label="OnlyLive — accueil">
          <span className="customer-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <span>Billetterie officielle</span>
      </header>

      <section className="marketing-hero">
        <span className="customer-summary-label">Événements live au Maroc</span>
        <h1>Vos prochains lives,<br />sans détour.</h1>
        <p>Réservez vos billets et retrouvez-les directement sur OnlyLive.</p>
      </section>

      <section className="marketing-events" aria-labelledby="events-title">
        <div className="marketing-section-heading">
          <div>
            <span className="customer-summary-label">À l’affiche</span>
            <h2 id="events-title">Événements</h2>
          </div>
          <span>{events.length} événement{events.length > 1 ? "s" : ""}</span>
        </div>

        {events.length === 0 ? (
          <div className="marketing-empty">Aucun événement pour le moment.</div>
        ) : (
          <ul className="marketing-event-list">
            {events.map((event) => {
              const day = formatEventDay(event.startsAt);
              const month = formatEventMonth(event.startsAt);
              const date = formatEventDateOnly(event.startsAt);

              return (
                <li key={event.id}>
                  <Link href={`/events/${event.slug}`} className="marketing-event-card">
                    <div className="marketing-event-date" aria-hidden="true">
                      <strong>{day}</strong>
                      <span>{month}</span>
                    </div>
                    <div className="marketing-event-copy">
                      <h3>{event.title}</h3>
                      <p>{event.venue.name} · {event.venue.city}</p>
                      <small>{date}</small>
                    </div>
                    <div className="marketing-event-action">
                      {event.status === "sold_out" ? <span className="marketing-sold-out">Complet</span> : <span>Voir les billets</span>}
                      <span aria-hidden="true">→</span>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {legalDocumentsApproved() && (
        <footer className="marketing-footer">
          <span>OnlyLive</span>
          <nav aria-label="Informations légales">
            <Link href="/legal/mentions-legales">Mentions légales</Link>
            <Link href="/legal/conditions-generales">CGV</Link>
            <Link href="/legal/politique-de-confidentialite">Confidentialité</Link>
            <Link href="/legal/politique-de-remboursement">Remboursement</Link>
          </nav>
        </footer>
      )}
    </main>
  );
}
