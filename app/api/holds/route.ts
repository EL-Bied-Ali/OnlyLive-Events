import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
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

    // Price and eligibility always come from the database, never from the
    // client — this is also where a phase's time window would be enforced.
    const phase = await prisma.salesPhase.findUnique({
      where: { id: parsed.data.salesPhaseId },
    });
    if (
      !phase ||
      phase.ticketCategoryId !== parsed.data.ticketCategoryId ||
      !phase.isActive ||
      phase.startsAt > new Date() ||
      (phase.endsAt && phase.endsAt < new Date())
    ) {
      throw new ApiError(409, "PHASE_NOT_AVAILABLE", "This sales phase is not currently open");
    }

    const result = await createHold({
      ticketCategoryId: parsed.data.ticketCategoryId,
      salesPhaseId: parsed.data.salesPhaseId,
      userId: customer.id,
      quantity: parsed.data.quantity,
      unitPriceCents: phase.priceCents,
    });

    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
