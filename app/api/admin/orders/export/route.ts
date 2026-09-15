import { NextRequest, NextResponse } from "next/server";
import { requireAdminRole } from "@/lib/auth/admin";
import { iterateOrdersForExport, isOrderStatus, type OrderForExport } from "@/lib/admin/dashboard";
import { CSV_BOM, formatCsvRow } from "@/lib/admin/csv";
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

function orderToRow(order: OrderForExport): (string | number)[] {
  return [
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
  ];
}

export async function GET(request: NextRequest) {
  try {
    // Read-only export: admin/super_admin/support, same as the orders page.
    // Checked before any streaming starts so an auth failure still gets a
    // normal error response rather than a truncated 200 body.
    await requireAdminRole(["super_admin", "admin", "support"]);

    const statusParam = request.nextUrl.searchParams.get("status") ?? undefined;
    const status = isOrderStatus(statusParam) ? statusParam : undefined;

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(CSV_BOM + formatCsvRow(HEADERS)));
          for await (const batch of iterateOrdersForExport(status)) {
            for (const order of batch) {
              controller.enqueue(encoder.encode(formatCsvRow(orderToRow(order))));
            }
          }
          controller.close();
        } catch (error) {
          // Headers are already sent by this point, so a mid-export DB
          // error can only surface as a truncated download, not a 500 —
          // this at least ends the stream instead of hanging the client.
          controller.error(error);
        }
      },
    });

    const filename = `onlylive-commandes-${new Date().toISOString().slice(0, 10)}${status ? `-${status}` : ""}.csv`;

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
