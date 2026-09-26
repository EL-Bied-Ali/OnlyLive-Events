import { NextRequest, NextResponse } from "next/server";
import { resetPasswordSchema } from "@/lib/validation/auth";
import { resetPasswordWithToken } from "@/lib/auth/passwordReset";
import { apiErrorResponse, ApiError } from "@/lib/http/errors";
import { buildRateLimitKey, consumeRateLimit, getClientIp, rateLimitHeaders } from "@/lib/rateLimit";

export const runtime = "nodejs";

// The token itself is 256 bits of entropy -- this isn't guarding against
// brute-forcing it, it's abuse protection against a client hammering the
// endpoint (and against wasting argon2 hashing cycles on garbage input).
const RESET_PASSWORD_IP_RATE_LIMIT = { limit: 20, windowMs: 15 * 60 * 1000 };

export async function POST(request: NextRequest) {
  try {
    const ip = getClientIp(request.headers);
    const ipLimit = await consumeRateLimit(buildRateLimitKey("reset_password_ip", ip), RESET_PASSWORD_IP_RATE_LIMIT);
    if (!ipLimit.allowed) {
      return NextResponse.json(
        { error: "RATE_LIMITED", message: "Too many attempts. Please try again later." },
        { status: 429, headers: rateLimitHeaders(ipLimit) },
      );
    }

    const body = await request.json();
    const parsed = resetPasswordSchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(400, "INVALID_INPUT", parsed.error.message);
    }

    const outcome = await resetPasswordWithToken(parsed.data.token, parsed.data.password);
    if (outcome === "invalid_or_expired") {
      // Never logged, never echoed: the token itself must never appear in
      // an error response, and this message covers not-found/used/expired
      // identically on purpose.
      throw new ApiError(400, "INVALID_OR_EXPIRED_TOKEN", "Ce lien de réinitialisation est invalide ou a expiré.");
    }

    return NextResponse.json({ message: "Votre mot de passe a été mis à jour." });
  } catch (error) {
    return apiErrorResponse(error);
  }
}
