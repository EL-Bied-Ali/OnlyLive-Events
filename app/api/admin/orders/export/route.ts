import { NextRequest, NextResponse } from "next/server";
import { requireAdminRole } from "@/lib/auth/admin";
import { getOrdersForExport, isOrderStatus } from "@/lib/admin/dashboard";
import { toCsv } from "@/lib/admin/csv";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

const HEADERS = [
  "Commande",
  "Événement",
  "Client",
  "Email",
  "Téléphone",
  "Statut",
  "Total",
  "Devise",
  "Billets",
  "Fournisseur de paiement",
  "Créée le",
];

export async function GET(request: NextRequest) {
  try {
    // Read-only export: admin/super_admin/support, same as the orders page.
    await requireAdminRole(["super_admin", "admin", "support"]);

    const statusParam = request.nextUrl.searchParams.get("status") ?? undefined;
    const status = isOrderStatus(statusParam) ? statusParam : undefined;
    const orders = await getOrdersForExport(status);

    const rows = orders.map((order) => [
      order.orderNumber,
      order.event.title,
      order.user.name ?? "",
      order.user.email,
      order.user.phone ?? "",
      order.status,
      (order.totalAmountCents / 100).toFixed(2),
      order.currency,
      order.items.map((item) => `${item.quantity}x ${item.ticketCategory.name}`).join("; "),
      order.payments[0]?.provider ?? "",
      order.createdAt.toISOString(),
    ]);

    const csv = toCsv(HEADERS, rows);
    const filename = `onlylive-commandes-${new Date().toISOString().slice(0, 10)}${status ? `-${status}` : ""}.csv`;

    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
