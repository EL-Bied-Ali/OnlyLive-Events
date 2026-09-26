import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
import type { AuthOptions, Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { loginSchema } from "@/lib/validation/auth";
import { ApiError } from "@/lib/http/errors";
import { buildRateLimitKey, consumeRateLimit, getClientIp, inspectRateLimit } from "@/lib/rateLimit";

// Per-account limiting stops distributed guessing; the higher IP ceiling
// avoids a few mistakes blocking many customers behind the same NAT.
const CUSTOMER_LOGIN_IP_RATE_LIMIT = { limit: 100, windowMs: 15 * 60 * 1000 };
const CUSTOMER_LOGIN_ACCOUNT_RATE_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 };

export const authOptions: AuthOptions = {
  // The adapter is kept registered for when an OAuth provider is added
  // later, but next-auth v4's Credentials provider only supports JWT
  // sessions (it throws CALLBACK_CREDENTIALS_JWT_ERROR under "database"
  // strategy — there's no persisted account to hang a database session
  // off of). There is still no generic "delete this one session" the way
  // admin sessions have; the session() callback below implements the one
  // revocation path this app actually needs (password reset invalidating
  // every outstanding session at once) via User.authVersion instead. See
  // docs/SECURITY.md's Session fixation row for the remaining gap.
  adapter: PrismaAdapter(prisma) as Adapter,
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60,
  },
  pages: {
    signIn: "/login",
  },
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Mot de passe", type: "password" },
      },
      async authorize(credentials, req) {
        const ip = getClientIp(req?.headers);
        const ipLimit = await consumeRateLimit(
          buildRateLimitKey("customer_login_ip", ip),
          CUSTOMER_LOGIN_IP_RATE_LIMIT,
        );
        if (!ipLimit.allowed) {
          // Thrown from authorize(), next-auth surfaces the message
          // verbatim as the `error` field the client-side signIn() call
          // resolves with (see app/(customer)/login/page.tsx).
          throw new Error("RATE_LIMITED");
        }

        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) {
          return null;
        }

        const accountKey = buildRateLimitKey("customer_login_account", parsed.data.email);
        const accountState = await inspectRateLimit(accountKey, CUSTOMER_LOGIN_ACCOUNT_RATE_LIMIT);
        if (!accountState.allowed) {
          throw new Error("RATE_LIMITED");
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user) {
          const failedAttempt = await consumeRateLimit(accountKey, CUSTOMER_LOGIN_ACCOUNT_RATE_LIMIT);
          if (!failedAttempt.allowed) throw new Error("RATE_LIMITED");
          return null;
        }

        const validPassword = await verifyPassword(user.passwordHash, parsed.data.password);
        if (!validPassword) {
          const failedAttempt = await consumeRateLimit(accountKey, CUSTOMER_LOGIN_ACCOUNT_RATE_LIMIT);
          if (!failedAttempt.allowed) throw new Error("RATE_LIMITED");
          return null;
        }

        // Successful credentials deliberately do not consume the account-level
        // failed-attempt budget. The per-IP limiter still counts every request.
        return { id: user.id, email: user.email, name: user.name, authVersion: user.authVersion };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
        token.authVersion = user.authVersion;
      }
      return token;
    },
    // Adds one DB read to every session check (not just sign-in), for a
    // real security property a JWT-strategy Credentials session otherwise
    // can't have: forcing every outstanding session to stop working the
    // moment a password reset completes. Correctness is worth that cost
    // here; see lib/auth/passwordReset.ts, which increments authVersion in
    // the same transaction as the password change.
    async session({ session, token }): Promise<Session> {
      if (!session.user || !token.sub) {
        return session;
      }

      const currentUser = await prisma.user.findUnique({
        where: { id: token.sub },
        select: { authVersion: true },
      });
      const tokenVersion = token.authVersion ?? 0;
      if (!currentUser || currentUser.authVersion !== tokenVersion) {
        // Same shape requireCustomer()/requireCustomerForPage() already
        // treat as unauthenticated (session.user.id missing) -- a stale
        // JWT from before a reset must look exactly like no session at all,
        // not a distinguishable third state.
        return { ...session, user: undefined } as unknown as typeof session;
      }

      session.user.id = token.sub;
      return session;
    },
  },
};

export function getCustomerSession() {
  return getServerSession(authOptions);
}

/**
 * Server-side guard for any route/action that requires a signed-in
 * customer. Never rely on hiding UI — every sensitive server operation
 * calls this explicitly.
 */
export async function requireCustomer() {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    throw new ApiError(401, "UNAUTHENTICATED", "Sign-in required");
  }
  return session.user as { id: string; email?: string | null; name?: string | null };
}

/**
 * Same guard for Server Components/pages, which can't return a JSON 401 —
 * redirects to the login page instead of throwing.
 */
export async function requireCustomerForPage(callbackUrl?: string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) {
    redirect(callbackUrl ? `/login?callbackUrl=${encodeURIComponent(callbackUrl)}` : "/login");
  }
  return session.user as { id: string; email?: string | null; name?: string | null };
}
