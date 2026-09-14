import { NextRequest, NextResponse } from "next/server";
import { requireAdminRole } from "@/lib/auth/admin";
import { assertAdminCsrf } from "@/lib/auth/adminCsrf";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { scanTicket } from "@/lib/scanner";
import { scanTicketSchema } from "@/lib/validation/scanner";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const scanner = await requireAdminRole(["super_admin", "admin", "scanner"]);
    assertAdminCsrf(request);

    const body = await request.json().catch(() => null);
    const parsed = scanTicketSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", "Invalid event or ticket token");
    }

    const result = await scanTicket({
      ...parsed.data,
      scannerAdminUserId: scanner.id,
    });
    return NextResponse.json(result);
  } catch (error) {
    return apiErrorResponse(error);
  }
}
