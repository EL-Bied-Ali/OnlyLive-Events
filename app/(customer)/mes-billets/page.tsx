import Link from "next/link";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { prisma } from "@/lib/db";
import { CustomerNav } from "@/components/CustomerNav";
import { formatEventDate } from "@/lib/formatEventDate";

export const dynamic = "force-dynamic";

const STATUS_PRESENTATION: Record<string, { label: string; tone: string }> = {
  valid: { label: "Valide", tone: "valid" },
  used: { label: "Scanné", tone: "used" },
  cancelled: { label: "Annulé", tone: "cancelled" },
};

type WalletTicket = Awaited<ReturnType<typeof loadTickets>>["upcoming"][number];

// Not a component -- Date.now() here is a plain data-fetch concern, not a
// render-purity violation (see react-hooks/purity, which flags impure calls
// inside component bodies).
async function loadTickets(userId: string) {
  // Explicit select, not include: this page never needs validationToken
  // (or any other Ticket column beyond these) -- no reason for a QR-capable
  // secret to be loaded into a server-side result set it's never read from.
  const tickets = await prisma.ticket.findMany({
    where: { orderItem: { order: { userId } } },
    select: {
      id: true,
      status: true,
      event: {
        select: {
          title: true,
          startsAt: true,
          venue: { select: { name: true, city: true } },
        },
      },
      ticketCategory: { select: { name: true } },
      orderItem: { select: { order: { select: { id: true } } } },
    },
    orderBy: { event: { startsAt: "asc" } },
  });

  const now = Date.now();
  return {
    upcoming: tickets.filter((ticket) => ticket.event.startsAt.getTime() >= now),
    past: tickets.filter((ticket) => ticket.event.startsAt.getTime() < now),
  };
}

function WalletCard({ ticket }: { ticket: WalletTicket }) {
  const status = STATUS_PRESENTATION[ticket.status] ?? { label: ticket.status, tone: "neutral" };
  const eventDate = formatEventDate(ticket.event.startsAt, "long");

  return (
    <Link
      href={`/orders/${ticket.orderItem.order.id}/tickets/${ticket.id}`}
      className={`customer-wallet-card customer-wallet-card-${status.tone}`}
    >
      <div className="customer-wallet-card-main">
        <span className="customer-wallet-card-date">{eventDate}</span>
        <h2>{ticket.event.title}</h2>
        <p>
          {ticket.event.venue.name}, {ticket.event.venue.city}
        </p>
        <p className="customer-wallet-card-category">{ticket.ticketCategory.name}</p>
      </div>
      <div className={`customer-wallet-card-status customer-wallet-card-status-${status.tone}`}>
        <span className="customer-wallet-card-status-dot" aria-hidden="true" />
        {status.label}
      </div>
    </Link>
  );
}

export default async function MesBilletsPage() {
  const customer = await requireCustomerForPage("/mes-billets");
  const { upcoming, past } = await loadTickets(customer.id);
  const hasTickets = upcoming.length + past.length > 0;

  return (
    <main className="customer-wallet-page">
      <CustomerNav />

      <div className="customer-wallet-heading">
        <h1>Mes billets</h1>
        <p>Retrouvez tous vos billets OnlyLive, prêts à être présentés à l’entrée.</p>
      </div>

      {!hasTickets ? (
        <div className="customer-wallet-empty">
          <p>Vous n’avez pas encore de billet.</p>
          <Link href="/" className="customer-primary-button customer-wallet-empty-cta">
            Découvrir les événements
          </Link>
        </div>
      ) : (
        <>
          {upcoming.length > 0 && (
            <section aria-labelledby="wallet-upcoming">
              <h2 id="wallet-upcoming" className="customer-wallet-section-title">
                À venir
              </h2>
              <div className="customer-wallet-list">
                {upcoming.map((ticket) => (
                  <WalletCard key={ticket.id} ticket={ticket} />
                ))}
              </div>
            </section>
          )}

          {past.length > 0 && (
            <section aria-labelledby="wallet-past">
              <h2 id="wallet-past" className="customer-wallet-section-title">
                Événements passés
              </h2>
              <div className="customer-wallet-list customer-wallet-list-past">
                {past.map((ticket) => (
                  <WalletCard key={ticket.id} ticket={ticket} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
