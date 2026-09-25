import type { DefaultSession, DefaultUser } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
    } & DefaultSession["user"];
  }

  interface User extends DefaultUser {
    // Carried from authorize() into the jwt() callback's `user` argument at
    // sign-in only -- see JWT.authVersion below for where it actually lives
    // across requests.
    authVersion: number;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    // The authVersion the User row had when this JWT was issued. Compared
    // against the live column on every session read (see
    // lib/auth/customer.ts's session() callback) so a password reset can
    // invalidate every outstanding session immediately, despite the
    // Credentials provider's JWT strategy having no persisted session row
    // to delete server-side. Absent on a JWT issued before this field
    // existed -- treated as 0, matching every pre-existing User row's
    // default.
    authVersion?: number;
  }
}
