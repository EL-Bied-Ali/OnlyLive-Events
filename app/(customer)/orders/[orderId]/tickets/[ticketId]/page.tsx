import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { renderTicketQrDataUrl } from "@/lib/tickets";

export const dynamic = "force-dynamic";

export default async function TicketPage({
  params,
}: {
  params: Promise<{ orderId: string; ticketId: string }>;
}) {
  const { orderId, ticketId } = await params;
  const customer = await requireCustomerForPage(`/orders/${orderId}/tickets/${ticketId}`);

  const ticket = await prisma.ticket.findUnique({
    where: { id: ticketId },
    include: {
      event: { include: { venue: true } },
      ticketCategory: true,
      orderItem: { include: { order: true } },
    },
  });

  // The ownership check goes through the order, not the ticket directly —
  // a ticket has no user_id of its own by design.
  if (!ticket || ticket.orderItem.order.id !== orderId || ticket.orderItem.order.userId !== customer.id) {
    notFound();
  }

  // The QR's validity is decided atomically by the backend scanner — this
  // data URL is a rendering convenience only, never a source of truth for
  // admission.
  const qrDataUrl = await renderTicketQrDataUrl(ticket.validationToken);

  const STATUS_LABELS: Record<string, string> = {
    valid: "Valide",
    used: "Déjà scanné",
    cancelled: "Annulé",
  };

  return (
    <main style={{ maxWidth: 420, margin: "0 auto", padding: "48px 16px", textAlign: "center" }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>OnlyLive</h1>
      <p style={{ opacity: 0.8, marginBottom: 24 }}>{ticket.event.title}</p>

      <div style={{ border: "1px solid #333", borderRadius: 12, padding: 24, marginBottom: 24 }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL, not an optimizable remote image */}
        <img src={qrDataUrl} alt="QR code du billet" style={{ width: "100%", maxWidth: 280, margin: "0 auto" }} />
      </div>

      <div style={{ textAlign: "left", display: "grid", gap: 4 }}>
        <p style={{ margin: 0 }}>
          <strong>Catégorie :</strong> {ticket.ticketCategory.name}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Lieu :</strong> {ticket.event.venue.name}, {ticket.event.venue.city}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Date :</strong>{" "}
          {new Intl.DateTimeFormat("fr-MA", { dateStyle: "full", timeStyle: "short" }).format(ticket.event.startsAt)}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Billet :</strong> {ticket.id}
        </p>
        <p style={{ margin: 0 }}>
          <strong>Statut :</strong> {STATUS_LABELS[ticket.status] ?? ticket.status}
        </p>
      </div>
    </main>
  );
}
