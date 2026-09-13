import { PrismaAdapter } from "@auth/prisma-adapter";
import type { Adapter } from "next-auth/adapters";
import type { AuthOptions } from "next-auth";
import { getServerSession } from "next-auth/next";
import { redirect } from "next/navigation";
import CredentialsProvider from "next-auth/providers/credentials";
import { prisma } from "@/lib/db";
import { verifyPassword } from "@/lib/auth/password";
import { loginSchema } from "@/lib/validation/auth";
import { ApiError } from "@/lib/http/errors";

export const authOptions: AuthOptions = {
  // The adapter is kept registered for when an OAuth provider is added
  // later, but next-auth v4's Credentials provider only supports JWT
  // sessions (it throws CALLBACK_CREDENTIALS_JWT_ERROR under "database"
  // strategy — there's no persisted account to hang a database session
  // off of). This means customer sessions can't be revoked server-side
  // the way admin sessions can; see docs/SECURITY.md for the tradeoff and
  // mitigation (short maxAge, documented as a known limitation).
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
      async authorize(credentials) {
        const parsed = loginSchema.safeParse(credentials);
        if (!parsed.success) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });
        if (!user) {
          return null;
        }

        const validPassword = await verifyPassword(user.passwordHash, parsed.data.password);
        if (!validPassword) {
          return null;
        }

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.sub = user.id;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
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
