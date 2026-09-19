import { NextRequest, NextResponse } from "next/server";
import { requireCustomer } from "@/lib/auth/customer";
import { updatePhoneSchema } from "@/lib/validation/auth";
import { updateCustomerPhone } from "@/lib/customers/phone";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { buildRateLimitKey, consumeRateLimit, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

// Already-authenticated abuse (repeatedly hammering the update endpoint) is
// the concern here, not credential guessing — a generous per-account allowance.
const PHONE_UPDATE_ACCOUNT_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

// Lets a customer who registered before phone became mandatory add one,
// so they can clear ChariPay's PAYMENT_CUSTOMER_DETAILS_REQUIRED at checkout.
export async function PATCH(request: NextRequest) {
  try {
    const customer = await requireCustomer();

    const limit = await consumeRateLimit(
      buildRateLimitKey("phone_update_account", customer.id),
      PHONE_UPDATE_ACCOUNT_RATE_LIMIT,
    );
    if (!limit.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
        { status: 429, headers: rateLimitHeaders(limit) },
      );
    }

    const body = await request.json();
    const parsed = updatePhoneSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    const user = await updateCustomerPhone(customer.id, parsed.data.phone);
    return NextResponse.json({ user });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
