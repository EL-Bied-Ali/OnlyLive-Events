import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCustomerForPage } from "@/lib/auth/customer";

export const dynamic = "force-dynamic";

const STATUS_LABELS: Record<string, string> = {
  pending_payment: "En attente de paiement",
  paid: "Payée",
  failed: "Paiement échoué",
  cancelled: "Annulée",
  refunded: "Remboursée",
  partially_refunded: "Partiellement remboursée",
  paid_but_unfulfillable: "Payée — en cours de traitement par notre équipe",
};

export default async function OrderPage({ params }: { params: Promise<{ orderId: string }> }) {
  const { orderId } = await params;
  const customer = await requireCustomerForPage(`/orders/${orderId}`);

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: {
      event: true,
      items: {
        include: {
          ticketCategory: true,
          tickets: true,
        },
      },
    },
  });

  if (!order || order.userId !== customer.id) {
    notFound();
  }

  return (
    <main style={{ maxWidth: 640, margin: "0 auto", padding: "48px 16px" }}>
      <h1 style={{ fontSize: 26, marginBottom: 4 }}>Commande {order.orderNumber}</h1>
      <p style={{ opacity: 0.8, marginBottom: 24 }}>{order.event.title}</p>

      <p style={{ marginBottom: 24 }}>
        Statut : <strong>{STATUS_LABELS[order.status] ?? order.status}</strong>
      </p>

      <div style={{ display: "grid", gap: 16 }}>
        {order.items.map((item) => (
          <div key={item.id} style={{ border: "1px solid #333", borderRadius: 12, padding: 20 }}>
            <p style={{ margin: "0 0 8px" }}>
              {item.quantity} × {item.ticketCategory.name} — {((item.quantity * item.unitPriceCents) / 100).toFixed(2)}{" "}
              {order.currency}
            </p>
            {item.tickets.length > 0 && (
              <ul style={{ margin: 0, paddingLeft: 16 }}>
                {item.tickets.map((ticket) => (
                  <li key={ticket.id}>
                    <Link href={`/orders/${order.id}/tickets/${ticket.id}`}>Voir le billet</Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </main>
  );
}
