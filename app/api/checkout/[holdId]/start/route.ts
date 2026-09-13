import { NextRequest, NextResponse } from "next/server";
import { requireCustomer } from "@/lib/auth/customer";
import { startCheckout } from "@/lib/orders/checkout";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: { params: Promise<{ holdId: string }> }) {
  try {
    const customer = await requireCustomer();
    const { holdId } = await context.params;
    const baseUrl = new URL(request.url).origin;
    const result = await startCheckout(holdId, customer.id, baseUrl);
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
