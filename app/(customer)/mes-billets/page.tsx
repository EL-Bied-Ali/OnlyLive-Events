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

// Same fallback convention as app/(marketing)/page.tsx's event-card thumbnail
// and app/(marketing)/events/[slug]/page.tsx's poster: coverImageUrl first,
// then a hardcoded asset for the one real seeded event that predates that
// column, then no image (a plain placeholder, never a broken <img>).
function eventThumbUrl(event: { coverImageUrl: string | null; slug: string }): string | null {
  if (event.coverImageUrl) return event.coverImageUrl;
  if (event.slug === "tiakola-casablanca-2026") return "/events/tiakola-casablanca-2026/square.webp";
  return null;
}

// Explicit select, not include: this page never needs validationToken (or
// any other Ticket column beyond these) -- no reason for a QR-capable
// secret to be loaded into a server-side result set it's never read from.
// Split out from loadTickets() below purely so WalletTicket has a type to
// derive from that doesn't itself depend on groupByOrder()/WalletTicket --
// referencing loadTickets' own return type here would be circular.
function fetchTickets(userId: string) {
  return prisma.ticket.findMany({
    where: { orderItem: { order: { userId } } },
    select: {
      id: true,
      status: true,
      event: {
        select: {
          title: true,
          startsAt: true,
          slug: true,
          coverImageUrl: true,
          venue: { select: { name: true, city: true } },
        },
      },
      ticketCategory: { select: { name: true } },
      orderItem: { select: { order: { select: { id: true } } } },
    },
    orderBy: { event: { startsAt: "asc" } },
  });
}

type WalletTicket = Awaited<ReturnType<typeof fetchTickets>>[number];
type TicketGroup = { orderId: string; tickets: WalletTicket[] };

// Not a component -- Date.now() here is a plain data-fetch concern, not a
// render-purity violation (see react-hooks/purity, which flags impure calls
// inside component bodies).
async function loadTickets(userId: string) {
  const tickets = await fetchTickets(userId);

  const now = Date.now();
  return {
    upcoming: groupByOrder(tickets.filter((ticket) => ticket.event.startsAt.getTime() >= now)),
    past: groupByOrder(tickets.filter((ticket) => ticket.event.startsAt.getTime() < now)),
  };
}

// One order is always for exactly one event (Order.eventId is a direct,
// non-nullable column), so grouping by order can never mix two events under
// one card -- every ticket in a group shares the same event/venue/date,
// safe to read off the group's first ticket alone.
function groupByOrder(tickets: WalletTicket[]): TicketGroup[] {
  const groups = new Map<string, TicketGroup>();
  for (const ticket of tickets) {
    const orderId = ticket.orderItem.order.id;
    const existing = groups.get(orderId);
    if (existing) {
      existing.tickets.push(ticket);
    } else {
      groups.set(orderId, { orderId, tickets: [ticket] });
    }
  }
  return [...groups.values()];
}

function WalletCardVisual({ thumbUrl }: { thumbUrl: string | null }) {
  return (
    <span className={`customer-wallet-card-visual${thumbUrl ? "" : " is-empty"}`} aria-hidden="true">
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- event artwork can be hosted on arbitrary approved origins.
        <img src={thumbUrl} alt="" />
      ) : null}
    </span>
  );
}

function StatusBadge({ status }: { status: { label: string; tone: string } }) {
  return (
    <span className={`customer-wallet-card-status customer-wallet-card-status-${status.tone}`}>
      <span className="customer-wallet-card-status-dot" aria-hidden="true" />
      {status.label}
    </span>
  );
}

function WalletGroupCard({ group }: { group: TicketGroup }) {
  // groupByOrder() never creates an empty group -- every group starts from
  // pushing its first ticket.
  const firstTicket = group.tickets[0]!;
  const eventDate = formatEventDate(firstTicket.event.startsAt, "long");
  const thumbUrl = eventThumbUrl(firstTicket.event);

  // The common case (one ticket per order) stays a single whole-card link,
  // same shape as before this page grouped anything. Only a genuine
  // multi-ticket order gets the heavier nested-rows treatment -- no reason
  // to make the typical purchase look more complex than it is.
  if (group.tickets.length === 1) {
    const ticket = firstTicket;
    const status = STATUS_PRESENTATION[ticket.status] ?? { label: ticket.status, tone: "neutral" };
    return (
      <Link
        href={`/orders/${group.orderId}/tickets/${ticket.id}`}
        className={`customer-wallet-card customer-wallet-card-${status.tone}`}
      >
        <WalletCardVisual thumbUrl={thumbUrl} />
        <div className="customer-wallet-card-main">
          <span className="customer-wallet-card-date">{eventDate}</span>
          <h2>{ticket.event.title}</h2>
          <p>
            {ticket.event.venue.name}, {ticket.event.venue.city}
          </p>
          <p className="customer-wallet-card-category">{ticket.ticketCategory.name}</p>
        </div>
        <StatusBadge status={status} />
      </Link>
    );
  }

  return (
    <article className="customer-wallet-card customer-wallet-card-group">
      <WalletCardVisual thumbUrl={thumbUrl} />
      <div className="customer-wallet-card-main">
        <span className="customer-wallet-card-date">{eventDate}</span>
        <h2>{firstTicket.event.title}</h2>
        <p>
          {firstTicket.event.venue.name}, {firstTicket.event.venue.city}
        </p>
        <p className="customer-wallet-card-category">{group.tickets.length} billets</p>
        <div className="customer-wallet-card-tickets">
          {group.tickets.map((ticket) => {
            const status = STATUS_PRESENTATION[ticket.status] ?? { label: ticket.status, tone: "neutral" };
            return (
              <Link
                key={ticket.id}
                href={`/orders/${group.orderId}/tickets/${ticket.id}`}
                className="customer-wallet-ticket-row"
              >
                <span>{ticket.ticketCategory.name}</span>
                <StatusBadge status={status} />
              </Link>
            );
          })}
        </div>
      </div>
    </article>
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
                {upcoming.map((group) => (
                  <WalletGroupCard key={group.orderId} group={group} />
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
                {past.map((group) => (
                  <WalletGroupCard key={group.orderId} group={group} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </main>
  );
}
