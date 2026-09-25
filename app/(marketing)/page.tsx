import Link from "next/link";
import { prisma } from "@/lib/db";
import { legalDocumentsApproved } from "@/lib/legal/approval";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const events = await prisma.event.findMany({
    where: { status: { in: ["published", "on_sale", "sold_out"] } },
    include: { venue: true },
    orderBy: { startsAt: "asc" },
  });

  return (
    <main className="live-home">
      <nav className="live-nav" aria-label="Navigation principale">
        <Link href="/" className="live-brand" aria-label="OnlyLive — accueil">
          <span className="live-brand-mark" aria-hidden="true">OL</span>
          <span>OnlyLive</span>
        </Link>
        <span className="live-nav-note">Casablanca · Maroc</span>
      </nav>

      <section className="live-home-hero" aria-labelledby="home-title">
        <p className="live-kicker"><span aria-hidden="true" /> Billetterie officielle</p>
        <h1 id="home-title">Le live commence<br /><em>ici.</em></h1>
        <div className="live-home-intro">
          <p>Des scènes qui vibrent. Des billets officiels. Une expérience pensée pour le public marocain.</p>
          <span>{events.length.toString().padStart(2, "0")} date{events.length === 1 ? "" : "s"} à l’affiche</span>
        </div>
      </section>

      <section className="live-program" aria-labelledby="program-title">
        <div className="live-section-heading">
          <p>À l’affiche</p>
          <h2 id="program-title">Prochainement sur scène</h2>
        </div>

        {events.length === 0 ? <p className="live-empty">Aucun événement pour le moment.</p> : null}

        <ul className="live-event-list">
          {events.map((event, index) => {
            const day = new Intl.DateTimeFormat("fr-MA", { day: "2-digit" }).format(event.startsAt);
            const month = new Intl.DateTimeFormat("fr-MA", { month: "short" }).format(event.startsAt).replace(".", "");
            return (
              <li key={event.id}>
                <Link href={`/events/${event.slug}`} className="live-event-card">
                  <span className="live-event-index">{String(index + 1).padStart(2, "0")}</span>
                  <span className="live-event-date" aria-label={new Intl.DateTimeFormat("fr-MA", { dateStyle: "long" }).format(event.startsAt)}>
                    <strong>{day}</strong><span>{month}</span>
                  </span>
                  <span className="live-event-copy">
                    <small>{event.venue.city} · {event.venue.name}</small>
                    <strong>{event.title}</strong>
                    <span>{event.status === "sold_out" ? "Complet" : "Découvrir les billets"}</span>
                  </span>
                  <span className="live-event-arrow" aria-hidden="true">↗</span>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {legalDocumentsApproved() && (
        <footer className="live-footer">
          <strong>OnlyLive</strong>
          <ul>
            <li>
              <Link href="/legal/mentions-legales">
                Mentions légales
              </Link>
            </li>
            <li>
              <Link href="/legal/conditions-generales">
                CGV
              </Link>
            </li>
            <li>
              <Link href="/legal/politique-de-confidentialite">
                Confidentialité
              </Link>
            </li>
            <li>
              <Link href="/legal/politique-de-remboursement">
                Remboursement
              </Link>
            </li>
          </ul>
        </footer>
      )}
    </main>
  );
}
