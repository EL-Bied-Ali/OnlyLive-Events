import Link from "next/link";
import { prisma } from "@/lib/db";
import { requireAdminForPage } from "@/lib/auth/admin";

const EVENT_LABELS: Record<string, string> = {
  draft: "Brouillon",
  published: "Publié",
  on_sale: "En vente",
  sold_out: "Complet",
  closed: "Clôturé",
  cancelled: "Annulé",
};

export default async function AdminEventsPage() {
  const [admin, events] = await Promise.all([
    requireAdminForPage(),
    prisma.event.findMany({
      orderBy: { startsAt: "asc" },
      include: {
        venue: true,
        ticketCategories: {
          orderBy: { sortOrder: "asc" },
          include: { inventory: true, salesPhases: { orderBy: { sortOrder: "asc" } } },
        },
      },
    }),
  ]);
  const canEdit = admin.role === "admin" || admin.role === "super_admin";

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div><p className="admin-eyebrow">Catalogue et capacités</p><h1>Événements</h1></div>
        <div className="admin-header-actions">
          <span className="admin-count">{events.length} événement(s)</span>
          {canEdit ? <Link className="admin-primary-link" href="/admin/events/new">Créer un événement</Link> : null}
        </div>
      </header>

      <section className="admin-event-cards">
        {events.map((event) => (
          <article className="admin-event-card" key={event.id}>
            <header>
              <div>
                <span className={`admin-status admin-status-${event.status}`}>{EVENT_LABELS[event.status]}</span>
                <h2>{event.title}</h2>
                <p>{event.venue.name}, {event.venue.city} · {new Intl.DateTimeFormat("fr-MA", { dateStyle: "full", timeStyle: "short" }).format(event.startsAt)}</p>
              </div>
              <div className="admin-event-total">
                <strong>{event.ticketCategories.reduce((sum, category) => sum + (category.inventory?.soldQuantity ?? 0), 0)}</strong>
                <span>billets vendus</span>
                {canEdit ? <Link href={`/admin/events/${event.id}`}>Gérer</Link> : null}
              </div>
            </header>
            <div className="admin-category-grid">
              {event.ticketCategories.map((category) => {
                const inventory = category.inventory;
                const available = inventory ? inventory.totalQuantity - inventory.reservedQuantity - inventory.soldQuantity : 0;
                return (
                  <div key={category.id}>
                    <strong>{category.name}</strong>
                    <dl>
                      <div><dt>Capacité</dt><dd>{inventory?.totalQuantity ?? 0}</dd></div>
                      <div><dt>Vendus</dt><dd>{inventory?.soldQuantity ?? 0}</dd></div>
                      <div><dt>Réservés</dt><dd>{inventory?.reservedQuantity ?? 0}</dd></div>
                      <div><dt>Disponibles</dt><dd>{available}</dd></div>
                    </dl>
                    <small>{category.salesPhases.filter((phase) => phase.isActive).length} phase(s) active(s)</small>
                  </div>
                );
              })}
              {event.ticketCategories.length === 0 && <p className="admin-empty">Aucune catégorie configurée.</p>}
            </div>
          </article>
        ))}
        {events.length === 0 && <div className="admin-panel admin-empty">Aucun événement configuré.</div>}
      </section>
    </main>
  );
}
