import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { requireScannerForPage } from "@/lib/auth/admin";
import { getAdminCsrfTokenForPage } from "@/lib/auth/adminCsrf";
import { ScannerClient } from "./ScannerClient";

export const metadata: Metadata = { title: "Scanner les billets · OnlyLive" };
export const dynamic = "force-dynamic";

export default async function ScannerPage() {
  const staff = await requireScannerForPage();
  const [csrfToken, events] = await Promise.all([
    getAdminCsrfTokenForPage(),
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
      csrfToken={csrfToken}
      events={events.map((event) => ({
        ...event,
        startsAt: event.startsAt.toISOString(),
      }))}
    />
  );
}
