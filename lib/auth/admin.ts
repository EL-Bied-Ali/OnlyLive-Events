import "server-only";
import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { prisma } from "@/lib/db";
import { ApiError } from "@/lib/http/errors";
import type { AdminRole, AdminUser } from "@prisma/client";

export const ADMIN_SESSION_COOKIE = "onlylive_admin_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function hashToken(token: string): string {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not set");
  }
  return crypto.createHmac("sha256", secret).update(token).digest("hex");
}

/**
 * Kept separate from customer auth (Auth.js) end-to-end: its own table, its
 * own httpOnly cookie, its own verification path. A bug in the
 * OAuth-capable customer stack can never escalate into admin/scanner
 * access because the code paths never intersect.
 */
export async function createAdminSession(
  adminUserId: string,
  meta: { ipAddress?: string | null; userAgent?: string | null },
): Promise<string> {
  const token = crypto.randomBytes(32).toString("base64url");
  const sessionTokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.adminSession.create({
    data: {
      adminUserId,
      sessionTokenHash,
      expiresAt,
      ipAddress: meta.ipAddress ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });

  return token;
}

export async function revokeAdminSession(token: string): Promise<void> {
  const sessionTokenHash = hashToken(token);
  await prisma.adminSession.deleteMany({ where: { sessionTokenHash } });
}

async function getValidAdminSession(): Promise<AdminUser | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ADMIN_SESSION_COOKIE)?.value;
  if (!token) {
    return null;
  }

  const sessionTokenHash = hashToken(token);
  const session = await prisma.adminSession.findUnique({
    where: { sessionTokenHash },
    include: { adminUser: true },
  });

  if (!session || session.expiresAt < new Date() || !session.adminUser.isActive) {
    return null;
  }

  return session.adminUser;
}

/**
 * Server-side guard for admin/scanner routes. Authorization is decided
 * here, in the route handler — never inferred from middleware or hidden
 * frontend UI.
 */
export async function requireAdminRole(allowedRoles: AdminRole[]): Promise<AdminUser> {
  const adminUser = await getValidAdminSession();
  if (!adminUser) {
    throw new ApiError(401, "UNAUTHENTICATED", "Admin sign-in required");
  }
  if (!allowedRoles.includes(adminUser.role)) {
    throw new ApiError(403, "FORBIDDEN", "Insufficient role");
  }
  return adminUser;
}

/**
 * Page-level equivalent of requireAdminRole. Admin pages redirect to the
 * isolated admin sign-in screen instead of rendering a JSON authentication
 * error. Scanner-only accounts deliberately cannot enter the back office.
 */
export async function requireAdminForPage(): Promise<AdminUser> {
  const adminUser = await getValidAdminSession();
  if (!adminUser) {
    redirect("/admin/login");
  }
  if (!(["super_admin", "admin", "support"] as AdminRole[]).includes(adminUser.role)) {
    redirect("/");
  }
  return adminUser;
}

/**
 * Scanner pages are available to dedicated scanner accounts and to the
 * two operational administrator roles. Support accounts remain read-only
 * back-office users and cannot validate admission tickets.
 */
export async function requireScannerForPage(): Promise<AdminUser> {
  const adminUser = await getValidAdminSession();
  if (!adminUser) {
    redirect("/scanner/login");
  }
  if (!(["super_admin", "admin", "scanner"] as AdminRole[]).includes(adminUser.role)) {
    redirect("/");
  }
  return adminUser;
}
