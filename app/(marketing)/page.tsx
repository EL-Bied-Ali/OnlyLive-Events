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
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 8 }}>OnlyLive</h1>
      <p style={{ opacity: 0.7, marginBottom: 32 }}>Billetterie officielle des événements live au Maroc</p>

      {events.length === 0 && <p>Aucun événement pour le moment.</p>}

      <ul style={{ listStyle: "none", padding: 0, display: "grid", gap: 16 }}>
        {events.map((event) => (
          <li key={event.id} style={{ border: "1px solid #333", borderRadius: 12, padding: 20 }}>
            <Link href={`/events/${event.slug}`} style={{ textDecoration: "none" }}>
              <h2 style={{ fontSize: 22, marginBottom: 4 }}>{event.title}</h2>
              <p style={{ opacity: 0.8, margin: 0 }}>
                {event.venue.name}, {event.venue.city} —{" "}
                {new Intl.DateTimeFormat("fr-MA", { dateStyle: "long" }).format(event.startsAt)}
              </p>
              {event.status === "sold_out" && (
                <span style={{ display: "inline-block", marginTop: 8, color: "#ff6b6b" }}>Complet</span>
              )}
            </Link>
          </li>
        ))}
      </ul>

      {legalDocumentsApproved() && (
        <footer style={{ marginTop: 64, paddingTop: 24, borderTop: "1px solid #333" }}>
          <ul style={{ listStyle: "none", padding: 0, display: "flex", gap: 16, flexWrap: "wrap" }}>
            <li>
              <Link href="/legal/mentions-legales" style={{ fontSize: 13, opacity: 0.7 }}>
                Mentions légales
              </Link>
            </li>
            <li>
              <Link href="/legal/conditions-generales" style={{ fontSize: 13, opacity: 0.7 }}>
                CGV
              </Link>
            </li>
            <li>
              <Link href="/legal/politique-de-confidentialite" style={{ fontSize: 13, opacity: 0.7 }}>
                Confidentialité
              </Link>
            </li>
            <li>
              <Link href="/legal/politique-de-remboursement" style={{ fontSize: 13, opacity: 0.7 }}>
                Remboursement
              </Link>
            </li>
          </ul>
        </footer>
      )}
    </main>
  );
}
