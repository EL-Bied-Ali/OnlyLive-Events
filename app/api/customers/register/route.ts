import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { registerSchema } from "@/lib/validation/auth";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { writeAuditLog } from "@/lib/audit";
import { checkRateLimit, getClientIp } from "@/lib/rateLimit";

export const runtime = "nodejs";

// Mass account creation is the abuse case here (bot signups, email
// enumeration via repeated attempts), not brute force — a generous but
// finite per-IP allowance.
const REGISTER_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request.headers);
    const withinLimit = await checkRateLimit(`register:${ip}`, REGISTER_RATE_LIMIT);
    if (!withinLimit) {
      throw new ApiError(429, "RATE_LIMITED", "Too many registration attempts. Please try again later.");
    }

    const body = await request.json();
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    // Whitelist exactly the validated fields — never spread the raw body
    // into a Prisma `create`, to avoid mass assignment.
    const { email, password, name, phone } = parsed.data;

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      // Same generic response as success would look different (email
      // already taken) — this is a deliberate tradeoff documented in
      // docs/SECURITY.md: registration inherently confirms whether an
      // email is taken (the user is told to log in instead), unlike
      // login/password-reset flows which must not leak this.
      throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists");
    }

    const passwordHash = await hashPassword(password);
    const user = await prisma.user.create({
      data: { email, passwordHash, name, phone },
      select: { id: true, email: true, name: true },
    });

    await writeAuditLog({
      actorType: "customer",
      actorId: user.id,
      action: "customer.registered",
      entityType: "User",
      entityId: user.id,
    });

    return NextResponse.json({ user }, { status: 201 });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
