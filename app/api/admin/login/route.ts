import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { adminLoginSchema } from "@/lib/validation/admin";
import { createAdminSession, ADMIN_SESSION_COOKIE } from "@/lib/auth/admin";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { writeAuditLog } from "@/lib/audit";

export const runtime = "nodejs";

// Same generic error for "no such account" and "wrong password" — never
// confirm whether an email belongs to an admin account (email enumeration
// hardening, see docs/SECURITY.md).
const INVALID_CREDENTIALS = new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password");

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const parsed = adminLoginSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    const admin = await prisma.adminUser.findUnique({ where: { email: parsed.data.email } });
    if (!admin || !admin.isActive) {
      throw INVALID_CREDENTIALS;
    }

    const validPassword = await verifyPassword(admin.passwordHash, parsed.data.password);
    if (!validPassword) {
      throw INVALID_CREDENTIALS;
    }

    const token = await createAdminSession(admin.id, {
      ipAddress: request.headers.get("x-forwarded-for"),
      userAgent: request.headers.get("user-agent"),
    });

    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: new Date() } });
    await writeAuditLog({
      actorType: "admin",
      actorId: admin.id,
      action: "admin.login",
      entityType: "AdminUser",
      entityId: admin.id,
    });

    const response = NextResponse.json({ admin: { id: admin.id, email: admin.email, role: admin.role } });
    response.cookies.set(ADMIN_SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 12 * 60 * 60,
    });
    return response;
  } catch (error) {
    return apiErrorResponse(error);
  }
}
