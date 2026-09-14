import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireAdminForPage } from "@/lib/auth/admin";
import { formatMoroccoDateTime } from "@/lib/validation/catalog";
import { AdminMutationForm } from "../AdminMutationForm";
import { createEventAction, createVenueAction } from "../actions";

function defaultLocalDate(daysFromNow: number, hour: number) {
  const date = new Date(Date.now() + daysFromNow * 86_400_000);
  return `${formatMoroccoDateTime(date).slice(0, 10)}T${String(hour).padStart(2, "0")}:00`;
}

export default async function NewAdminEventPage() {
  const [admin, venues] = await Promise.all([
    requireAdminForPage(),
    prisma.venue.findMany({ orderBy: [{ city: "asc" }, { name: "asc" }] }),
  ]);
  if (admin.role === "support") redirect("/admin/events");

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div><p className="admin-eyebrow">Catalogue</p><h1>Nouvel événement</h1></div>
      </header>

      <div className="admin-form-grid">
        <section className="admin-panel admin-form-panel">
          <h2>1. Lieu</h2>
          <p className="admin-muted">Créez le lieu seulement s’il n’existe pas encore, puis sélectionnez-le dans l’événement.</p>
          <AdminMutationForm action={createVenueAction} submitLabel="Créer le lieu">
            <label>Nom<input name="name" required maxLength={120} /></label>
            <label>Adresse<input name="addressLine1" required maxLength={200} /></label>
            <label>Complément<input name="addressLine2" maxLength={200} /></label>
            <label>Ville<input name="city" required maxLength={100} defaultValue="Casablanca" /></label>
            <label>Pays<input name="country" required maxLength={2} defaultValue="MA" /></label>
            <label>Capacité du lieu<input name="capacity" type="number" min={1} max={10_000_000} /></label>
          </AdminMutationForm>
        </section>

        <section className="admin-panel admin-form-panel">
          <h2>2. Événement</h2>
          {venues.length === 0 ? (
            <p className="admin-form-error">Créez d’abord un lieu.</p>
          ) : (
            <AdminMutationForm action={createEventAction} submitLabel="Créer l’événement">
              <label>Titre<input name="title" required maxLength={160} /></label>
              <label>URL courte<input name="slug" required maxLength={100} pattern="[a-z0-9]+(?:-[a-z0-9]+)*" placeholder="artiste-casablanca-2027" /></label>
              <label className="admin-field-wide">Description<textarea name="description" required minLength={10} maxLength={10_000} rows={5} /></label>
              <label>Lieu<select name="venueId" required>{venues.map((venue) => <option key={venue.id} value={venue.id}>{venue.name} — {venue.city}</option>)}</select></label>
              <label>Statut<select name="status" defaultValue="draft"><option value="draft">Brouillon</option><option value="published">Publié</option><option value="on_sale">En vente</option></select></label>
              <label>Début (heure du Maroc)<input name="startsAt" type="datetime-local" required defaultValue={defaultLocalDate(90, 20)} /></label>
              <label>Ouverture des portes<input name="doorsOpenAt" type="datetime-local" defaultValue={defaultLocalDate(90, 18)} /></label>
              <label>Ouverture des ventes<input name="salesOpenAt" type="datetime-local" required defaultValue={defaultLocalDate(0, 10)} /></label>
              <label>Clôture des ventes<input name="salesCloseAt" type="datetime-local" required defaultValue={defaultLocalDate(90, 19)} /></label>
              <label className="admin-field-wide">URL de l’affiche<input name="coverImageUrl" type="url" maxLength={2_000} /></label>
            </AdminMutationForm>
          )}
        </section>
      </div>
    </main>
  );
}
