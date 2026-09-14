import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdminForPage } from "@/lib/auth/admin";
import { formatMoroccoDateTime } from "@/lib/validation/catalog";
import { AdminMutationForm } from "../AdminMutationForm";
import {
  createCategoryAction,
  createSalesPhaseAction,
  updateCategoryAction,
  updateEventAction,
  updateSalesPhaseAction,
} from "../actions";

type PageProps = { params: Promise<{ eventId: string }> };

const STATUS_OPTIONS = [
  ["draft", "Brouillon"],
  ["published", "Publié"],
  ["on_sale", "En vente"],
  ["sold_out", "Complet"],
  ["closed", "Clôturé"],
  ["cancelled", "Annulé"],
] as const;

export default async function ManageAdminEventPage({ params }: PageProps) {
  const { eventId } = await params;
  const [admin, event, venues] = await Promise.all([
    requireAdminForPage(),
    prisma.event.findUnique({
      where: { id: eventId },
      include: {
        venue: true,
        ticketCategories: {
          orderBy: { sortOrder: "asc" },
          include: {
            inventory: true,
            salesPhases: { orderBy: [{ sortOrder: "asc" }, { startsAt: "asc" }] },
          },
        },
      },
    }),
    prisma.venue.findMany({ orderBy: [{ city: "asc" }, { name: "asc" }] }),
  ]);
  if (!event) notFound();
  if (admin.role === "support") redirect("/admin/events");

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div>
          <p className="admin-eyebrow">Gestion du catalogue</p>
          <h1>{event.title}</h1>
          <p className="admin-muted">Les horaires sont saisis et affichés dans le fuseau Africa/Casablanca.</p>
        </div>
        <Link className="admin-secondary-link" href="/admin/events">Retour aux événements</Link>
      </header>

      <section className="admin-panel admin-form-panel">
        <h2>Informations de l’événement</h2>
        <AdminMutationForm action={updateEventAction} submitLabel="Enregistrer l’événement">
          <input name="eventId" type="hidden" value={event.id} />
          <label>Titre<input name="title" required maxLength={160} defaultValue={event.title} /></label>
          <label>URL courte<input name="slug" required maxLength={100} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" defaultValue={event.slug} /></label>
          <label className="admin-field-wide">Description<textarea name="description" required minLength={10} maxLength={10_000} rows={5} defaultValue={event.description} /></label>
          <label>Lieu<select name="venueId" required defaultValue={event.venueId}>{venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name} — {venue.city}</option>)}</select></label>
          <label>Statut<select name="status" defaultValue={event.status}>{STATUS_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <label>Début (heure du Maroc)<input name="startsAt" type="datetime-local" required defaultValue={formatMoroccoDateTime(event.startsAt)} /></label>
          <label>Ouverture des portes<input name="doorsOpenAt" type="datetime-local" defaultValue={event.doorsOpenAt ? formatMoroccoDateTime(event.doorsOpenAt) : ""} /></label>
          <label>Ouverture des ventes<input name="salesOpenAt" type="datetime-local" required defaultValue={formatMoroccoDateTime(event.salesOpenAt)} /></label>
          <label>Clôture des ventes<input name="salesCloseAt" type="datetime-local" required defaultValue={formatMoroccoDateTime(event.salesCloseAt)} /></label>
          <label className="admin-field-wide">URL de l’affiche<input name="coverImageUrl" type="url" maxLength={2_000} defaultValue={event.coverImageUrl ?? ""} /></label>
        </AdminMutationForm>
      </section>

      <section className="admin-catalog-section">
        <header><div><p className="admin-eyebrow">Billetterie</p><h2>Catégories et phases</h2></div></header>

        <article className="admin-panel admin-form-panel">
          <h3>Nouvelle catégorie</h3>
          <AdminMutationForm action={createCategoryAction} submitLabel="Ajouter la catégorie">
            <input name="eventId" type="hidden" value={event.id} />
            <label>Nom<input name="name" required maxLength={80} placeholder="VIP" /></label>
            <label>Capacité<input name="totalQuantity" required type="number" min={0} max={10_000_000} /></label>
            <label>Ordre<input name="sortOrder" required type="number" min={0} max={10_000} defaultValue={event.ticketCategories.length} /></label>
            <label className="admin-checkbox"><input name="isActive" type="checkbox" defaultChecked /> Active</label>
            <label className="admin-field-wide">Description<input name="description" maxLength={500} /></label>
          </AdminMutationForm>
        </article>

        <div className="admin-category-editor-list">
          {event.ticketCategories.map((category) => (
            <article className="admin-panel admin-form-panel" key={category.id}>
              <div className="admin-editor-heading">
                <div><h3>{category.name}</h3><p>{category.inventory?.soldQuantity ?? 0} vendu(s) · {category.inventory?.reservedQuantity ?? 0} réservé(s)</p></div>
                <span className={`admin-status ${category.isActive ? "admin-status-on_sale" : "admin-status-cancelled"}`}>{category.isActive ? "Active" : "Inactive"}</span>
              </div>
              <AdminMutationForm action={updateCategoryAction} submitLabel="Enregistrer la catégorie">
                <input name="categoryId" type="hidden" value={category.id} />
                <input name="eventId" type="hidden" value={event.id} />
                <label>Nom<input name="name" required maxLength={80} defaultValue={category.name} /></label>
                <label>Capacité<input name="totalQuantity" required type="number" min={(category.inventory?.soldQuantity ?? 0) + (category.inventory?.reservedQuantity ?? 0)} max={10_000_000} defaultValue={category.inventory?.totalQuantity ?? 0} /></label>
                <label>Ordre<input name="sortOrder" required type="number" min={0} max={10_000} defaultValue={category.sortOrder} /></label>
                <label className="admin-checkbox"><input name="isActive" type="checkbox" defaultChecked={category.isActive} /> Active</label>
                <label className="admin-field-wide">Description<input name="description" maxLength={500} defaultValue={category.description ?? ""} /></label>
              </AdminMutationForm>

              <div className="admin-phase-list">
                {category.salesPhases.map((phase) => (
                  <AdminMutationForm action={updateSalesPhaseAction} submitLabel="Enregistrer la phase" className="admin-edit-form admin-phase-form" key={phase.id}>
                    <input name="phaseId" type="hidden" value={phase.id} />
                    <input name="ticketCategoryId" type="hidden" value={category.id} />
                    <label>Phase<input name="name" required maxLength={100} defaultValue={phase.name} /></label>
                    <label>Prix (MAD)<input name="priceCents" required inputMode="decimal" defaultValue={(phase.priceCents / 100).toFixed(2)} /></label>
                    <label>Début<input name="startsAt" type="datetime-local" required defaultValue={formatMoroccoDateTime(phase.startsAt)} /></label>
                    <label>Fin<input name="endsAt" type="datetime-local" defaultValue={phase.endsAt ? formatMoroccoDateTime(phase.endsAt) : ""} /></label>
                    <label>Plafond<input name="phaseQuantityLimit" type="number" min={1} max={category.inventory?.totalQuantity ?? 10_000_000} defaultValue={phase.phaseQuantityLimit ?? ""} /></label>
                    <label>Ordre<input name="sortOrder" required type="number" min={0} max={10_000} defaultValue={phase.sortOrder} /></label>
                    <label className="admin-checkbox"><input name="isActive" type="checkbox" defaultChecked={phase.isActive} /> Active</label>
                  </AdminMutationForm>
                ))}

                <details className="admin-new-phase">
                  <summary>Ajouter une phase de vente</summary>
                  <AdminMutationForm action={createSalesPhaseAction} submitLabel="Créer la phase" className="admin-edit-form admin-phase-form">
                    <input name="ticketCategoryId" type="hidden" value={category.id} />
                    <label>Phase<input name="name" required maxLength={100} placeholder="Phase 2" /></label>
                    <label>Prix (MAD)<input name="priceCents" required inputMode="decimal" placeholder="500.00" /></label>
                    <label>Début<input name="startsAt" type="datetime-local" required defaultValue={formatMoroccoDateTime(event.salesOpenAt)} /></label>
                    <label>Fin<input name="endsAt" type="datetime-local" defaultValue={formatMoroccoDateTime(event.salesCloseAt)} /></label>
                    <label>Plafond<input name="phaseQuantityLimit" type="number" min={1} max={category.inventory?.totalQuantity ?? 10_000_000} /></label>
                    <label>Ordre<input name="sortOrder" required type="number" min={0} max={10_000} defaultValue={category.salesPhases.length} /></label>
                    <label className="admin-checkbox"><input name="isActive" type="checkbox" /> Active</label>
                  </AdminMutationForm>
                </details>
              </div>
            </article>
          ))}
        </div>
      </section>
    </main>
  );
}
