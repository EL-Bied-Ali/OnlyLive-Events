import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { requireCustomerForPage } from "@/lib/auth/customer";
import { CheckoutClient } from "./CheckoutClient";

export const dynamic = "force-dynamic";

export default async function CheckoutHoldPage({ params }: { params: Promise<{ holdId: string }> }) {
  const { holdId } = await params;
  const customer = await requireCustomerForPage(`/checkout/hold/${holdId}`);

  const reservation = await prisma.reservation.findUnique({
    where: { id: holdId },
    include: { ticketCategory: { include: { event: true } }, salesPhase: true },
  });

  // Ownership mismatch and "doesn't exist" look identical to the customer
  // — this deliberately avoids confirming another customer's reservation
  // exists (see docs/SECURITY.md).
  if (!reservation || reservation.userId !== customer.id) {
    notFound();
  }

  return (
    <CheckoutClient
      reservationId={reservation.id}
      expiresAt={reservation.expiresAt.toISOString()}
      quantity={reservation.quantity}
      unitPriceCents={reservation.unitPriceCents}
      currency={reservation.salesPhase.currency}
      categoryName={reservation.ticketCategory.name}
      eventTitle={reservation.ticketCategory.event.title}
    />
  );
}
