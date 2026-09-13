import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireScannerForPage } from "@/lib/auth/admin";
import { ScannerClient } from "./ScannerClient";

export const metadata: Metadata = { title: "Scanner les billets · OnlyLive" };
export const dynamic = "force-dynamic";

export default async function ScannerPage() {
  const [staff, events] = await Promise.all([
    requireScannerForPage(),
    prisma.event.findMany({
      where: { status: { in: ["published", "on_sale", "sold_out", "closed"] } },
      orderBy: { startsAt: "asc" },
      select: {
        id: true,
        title: true,
        startsAt: true,
        venue: { select: { name: true, city: true } },
      },
    }),
  ]);

  return (
    <ScannerClient
      staffName={staff.name}
      events={events.map((event) => ({
        ...event,
        startsAt: event.startsAt.toISOString(),
      }))}
    />
  );
}
