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
    await requireAdminRole(["super_admin", "admin", "support"]);

    const statusParam = request.nextUrl.searchParams.get("status") ?? undefined;
    const status = isOrderStatus(statusParam) ? statusParam : undefined;

    const encoder = new TextEncoder();
    const batches = iterateOrdersForExport(status)[Symbol.asyncIterator]();
    let headerPending = true;
    let currentBatch: OrderForExport[] = [];
    let currentIndex = 0;

    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (headerPending) {
            headerPending = false;
            controller.enqueue(encoder.encode(CSV_BOM + formatCsvRow(HEADERS)));
            return;
          }

          while (currentIndex >= currentBatch.length) {
            const next = await batches.next();
            if (next.done) {
              controller.close();
              return;
            }
            currentBatch = next.value;
            currentIndex = 0;
          }

          controller.enqueue(encoder.encode(formatCsvRow(orderToRow(currentBatch[currentIndex++]!))));
        } catch (error) {
          // Auth has already completed before the stream is created. A later
          // DB/read failure cannot change the HTTP status after headers are
          // committed, so abort the response body rather than silently
          // pretending the export completed successfully.
          controller.error(error);
          await batches.return?.(undefined);
        }
      },
      async cancel() {
        await batches.return?.(undefined);
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
