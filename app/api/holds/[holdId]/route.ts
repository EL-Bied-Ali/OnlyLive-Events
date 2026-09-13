import { NextRequest, NextResponse } from "next/server";
import { requireCustomer } from "@/lib/auth/customer";
import { releaseHold } from "@/lib/inventory";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

export async function DELETE(request: NextRequest, context: { params: Promise<{ holdId: string }> }) {
  try {
    const customer = await requireCustomer();
    const { holdId } = await context.params;
    await releaseHold(holdId, customer.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
