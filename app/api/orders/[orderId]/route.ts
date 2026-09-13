import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/customer";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: { params: Promise<{ orderId: string }> }) {
  try {
    const customer = await requireCustomer();
    const { orderId } = await context.params;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: {
        event: { select: { title: true } },
        items: {
          include: {
            ticketCategory: { select: { name: true } },
            tickets: { select: { id: true, status: true } },
          },
        },
        payments: { select: { id: true, status: true, provider: true } },
      },
    });

    // Ownership mismatch and "doesn't exist" return the identical 404 —
    // never confirm another customer's order exists (IDOR hardening).
    if (!order || order.userId !== customer.id) {
      return NextResponse.json({ error: "ORDER_NOT_FOUND" }, { status: 404 });
    }

    return NextResponse.json({ order });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
