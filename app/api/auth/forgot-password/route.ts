import { NextRequest, NextResponse } from "next/server";
import { forgotPasswordSchema } from "@/lib/validation/auth";
import { requestPasswordReset } from "@/lib/auth/passwordReset";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { buildRateLimitKey, consumeRateLimit, getClientIp, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

// Same abuse shape as registration: mass requests (enumeration attempts,
// or just spamming a stranger's inbox), not credential brute force.
const FORGOT_PASSWORD_IP_RATE_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };
const FORGOT_PASSWORD_EMAIL_RATE_LIMIT = { limit: 5, windowMs: 15 * 60 * 1000 };

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request.headers);
    const ipLimit = await consumeRateLimit(buildRateLimitKey("forgot_password_ip", ip), FORGOT_PASSWORD_IP_RATE_LIMIT);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
        { status: 429, headers: rateLimitHeaders(ipLimit) },
      );
    }

    const body = await request.json();
    const parsed = forgotPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    // The email is HMACed inside buildRateLimitKey — never persisted raw.
    const emailLimit = await consumeRateLimit(
      buildRateLimitKey("forgot_password_email", parsed.data.email),
      FORGOT_PASSWORD_EMAIL_RATE_LIMIT,
    );
    if (!emailLimit.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
        { status: 429, headers: rateLimitHeaders(emailLimit) },
      );
    }

    // Never branch on whether requestPasswordReset actually found an
    // account -- same neutral response either way, or this endpoint
    // becomes an account-enumeration oracle.
    await requestPasswordReset(parsed.data.email);

    return NextResponse.json({
      message: "Si un compte existe avec cette adresse, un email de réinitialisation vient d’être envoyé.",
    });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
