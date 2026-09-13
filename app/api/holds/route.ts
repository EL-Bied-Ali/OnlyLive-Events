import { NextRequest, NextResponse } from "next/server";
import { requireCustomer } from "@/lib/auth/customer";
import { createHoldSchema } from "@/lib/validation/holds";
import { createHold } from "@/lib/inventory";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const customer = await requireCustomer();

    const body = await request.json();
    const parsed = createHoldSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    // Every eligibility check (event/category/phase status and windows,
    // phase quantity limit, per-user/event purchase limit) and the price
    // itself are decided inside createHold's own locked transaction —
    // never here, and never from the client.
    const result = await createHold({
      ticketCategoryId: parsed.data.ticketCategoryId,
      salesPhaseId: parsed.data.salesPhaseId,
      userId: customer.id,
      quantity: parsed.data.quantity,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
