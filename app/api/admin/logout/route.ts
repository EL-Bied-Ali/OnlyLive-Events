import { NextRequest, NextResponse } from "next/server";
import { revokeAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/auth/admin";
import { assertAdminCsrf } from "@/lib/auth/adminCsrf";
import { apiErrorResponse } from "@/lib/http/errors";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    assertAdminCsrf(request);

    const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
    if (token) {
      await revokeAdminSession(token);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.delete(ADMIN_SESSION_COOKIE);
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
