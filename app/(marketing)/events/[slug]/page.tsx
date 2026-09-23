import { notFound } from "next/navigation";
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

  return (
    <main style={{ maxWidth: 720, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 32, fontWeight: 700, marginBottom: 4 }}>{event.title}</h1>
      <p style={{ opacity: 0.8, marginBottom: 4 }}>
        {event.venue.name}, {event.venue.city}
      </p>
      <p style={{ opacity: 0.8, marginBottom: 24 }}>
        {new Intl.DateTimeFormat("fr-MA", { dateStyle: "full", timeStyle: "short" }).format(event.startsAt)}
      </p>
      <p style={{ marginBottom: 32 }}>{event.description}</p>

      {event.status === "cancelled" ? (
        <p role="alert" style={{ padding: 16, borderRadius: 10, background: "#3d1d27", color: "#ffb0c0" }}>
          Cet événement est annulé. Les détenteurs de billets seront contactés par OnlyLive.
        </p>
      ) : null}

      <h2 style={{ fontSize: 22, marginBottom: 16 }}>Billets</h2>
      <div style={{ display: "grid", gap: 24 }}>
        {event.ticketCategories.map((category) => {
          const inventory = category.inventory;
          const available = inventory
            ? inventory.totalQuantity - inventory.reservedQuantity - inventory.soldQuantity
            : 0;
          const openPhase = salesAreOpen ? category.salesPhases.find(
            (phase) => phase.startsAt <= now && (!phase.endsAt || phase.endsAt > now),
          ) : undefined;

          return (
            <div key={category.id} style={{ border: "1px solid #333", borderRadius: 12, padding: 20 }}>
              <h3 style={{ fontSize: 18, marginBottom: 4 }}>{category.name}</h3>
              {category.description && <p style={{ opacity: 0.7, marginBottom: 12 }}>{category.description}</p>}

              {!openPhase && event.status !== "cancelled" ? <p style={{ opacity: 0.6 }}>Aucune vente ouverte pour le moment</p> : null}

              {openPhase && (
                <>
                  <p style={{ fontSize: 20, fontWeight: 600, marginBottom: 12 }}>
                    {(openPhase.priceCents / 100).toFixed(2)} {openPhase.currency}
                    <span style={{ fontSize: 14, opacity: 0.6, marginLeft: 8 }}>({openPhase.name})</span>
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
          );
        })}
      </div>
    </main>
  );
}
