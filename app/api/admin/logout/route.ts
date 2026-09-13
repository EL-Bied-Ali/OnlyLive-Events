import { NextRequest, NextResponse } from "next/server";
import { revokeAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/auth/admin";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const token = request.cookies.get(ADMIN_SESSION_COOKIE)?.value;
  if (token) {
    await revokeAdminSession(token);
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.delete(ADMIN_SESSION_COOKIE);
  return response;
}
