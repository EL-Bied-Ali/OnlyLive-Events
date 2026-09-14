import Link from "next/link";
import { getAuditLog, getAuditLogEntityTypes } from "@/lib/admin/audit";

export const dynamic = "force-dynamic";

function formatDate(date: Date) {
  return new Intl.DateTimeFormat("fr-MA", { dateStyle: "medium", timeStyle: "medium" }).format(date);
}

function actorLabel(entry: { actorType: string; actorId: string | null; actorName: string | null }) {
  if (entry.actorType === "system") return "Système";
  if (entry.actorName) return entry.actorName;
  if (entry.actorId) return `${entry.actorType} · ${entry.actorId.slice(0, 8)}…`;
  return entry.actorType;
}

export default async function AdminAuditPage({
  searchParams,
}: {
  searchParams: Promise<{ entityType?: string; before?: string }>;
}) {
  const { entityType, before } = await searchParams;
  const [{ entries, nextCursor }, entityTypes] = await Promise.all([
    getAuditLog({ entityType, before }),
    getAuditLogEntityTypes(),
  ]);

  const filterHref = (type?: string) => (type ? `/admin/audit?entityType=${type}` : "/admin/audit");

  return (
    <main className="admin-page">
      <header className="admin-page-header">
        <div>
          <p className="admin-eyebrow">Traçabilité</p>
          <h1>Journal d’audit</h1>
        </div>
        <span className="admin-count">{entries.length} résultat(s)</span>
      </header>

      <nav className="admin-filters" aria-label="Filtrer par type d’entité">
        <Link className={!entityType ? "active" : ""} href={filterHref()}>Tout</Link>
        {entityTypes.map((type) => (
          <Link key={type} className={entityType === type ? "active" : ""} href={filterHref(type)}>{type}</Link>
        ))}
      </nav>

      <section className="admin-panel">
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Acteur</th>
                <th>Action</th>
                <th>Entité</th>
                <th>Détails</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => (
                <tr key={entry.id}>
                  <td>{formatDate(entry.createdAt)}</td>
                  <td>{actorLabel(entry)}</td>
                  <td><code>{entry.action}</code></td>
                  <td>{entry.entityType} <small>{entry.entityId.slice(0, 8)}…</small></td>
                  <td>
                    {entry.metadata ? (
                      <pre className="admin-audit-metadata">{JSON.stringify(entry.metadata)}</pre>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
              {entries.length === 0 && <tr><td colSpan={5} className="admin-empty">Aucun événement d’audit pour ce filtre.</td></tr>}
            </tbody>
          </table>
        </div>
        {nextCursor && (
          <div className="admin-panel-footer">
            <Link href={`/admin/audit?${entityType ? `entityType=${entityType}&` : ""}before=${nextCursor}`}>
              Page suivante →
            </Link>
          </div>
        )}
      </section>
    </main>
  );
}
