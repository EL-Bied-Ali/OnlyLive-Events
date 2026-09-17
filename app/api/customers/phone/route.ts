import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { requireCustomer } from "@/lib/auth/customer";
import { updatePhoneSchema } from "@/lib/validation/auth";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

// Lets a customer who registered before phone became mandatory add one,
// so they can clear ChariPay's PAYMENT_CUSTOMER_DETAILS_REQUIRED at checkout.
export async function PATCH(request: NextRequest) {
  try {
    const customer = await requireCustomer();
    const body = await request.json();
    const parsed = updatePhoneSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    const { phone } = parsed.data;
    await prisma.user.update({ where: { id: customer.id }, data: { phone } });

    await writeAuditLog({
      actorType: "customer",
      actorId: customer.id,
      action: "customer.phone_updated",
      entityType: "User",
      entityId: customer.id,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
