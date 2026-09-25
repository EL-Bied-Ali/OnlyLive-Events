import { createHash, randomUUID } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Session } from "next-auth";
import { prisma } from "@/lib/db";
import { createTestUser } from "../helpers/fixtures";

const sendMock = vi.fn().mockResolvedValue({ providerMessageId: "test_message_id" });

vi.mock("@/lib/email", () => ({
  getEmailProvider: () => ({ name: "mock", send: sendMock }),
}));

function extractRawToken(emailText: string): string {
  const match = emailText.match(/token=([0-9a-f]+)/);
  const token = match?.[1];
  if (!token) throw new Error("No reset token found in email body");
  return token;
}

function lastSendInput(): { to: string; text: string } {
  const call = sendMock.mock.calls.at(-1);
  if (!call) throw new Error("Email provider's send() was never called");
  return call[0];
}

describe("requestPasswordReset", () => {
  afterEach(() => {
    sendMock.mockClear();
  });

  it("creates a single-use token and emails a link containing it, hashed at rest", async () => {
    const user = await createTestUser("reset-request");
    const { requestPasswordReset } = await import("@/lib/auth/passwordReset");

    await requestPasswordReset(user.email);

    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(lastSendInput().to).toBe(user.email);

    const rawToken = extractRawToken(lastSendInput().text);
    const expectedHash = createHash("sha256").update(rawToken).digest("hex");

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tokenHash).toBe(expectedHash);
    expect(rows[0]!.usedAt).toBeNull();
  });

  it("does nothing observable for an email with no account -- never confirms or denies existence", async () => {
    const { requestPasswordReset } = await import("@/lib/auth/passwordReset");

    await expect(requestPasswordReset("no-such-account@test.onlylive.ma")).resolves.toBeUndefined();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("puts the token in a URL fragment, never a query string", async () => {
    const user = await createTestUser("reset-fragment");
    const { requestPasswordReset } = await import("@/lib/auth/passwordReset");

    await requestPasswordReset(user.email);

    const linkLine = lastSendInput().text.split("\n").find((line) => line.includes("http"));
    expect(linkLine).toBeDefined();
    // A query string is sent to the server and can land in access/runtime
    // logs and browser history; a fragment never leaves the browser.
    expect(linkLine).toContain("#token=");
    expect(linkLine).not.toContain("?token=");
  });

  it("marks the reset email sensitive, so a real console/log-based provider never prints it", async () => {
    const user = await createTestUser("reset-sensitive-flag");
    const { requestPasswordReset } = await import("@/lib/auth/passwordReset");

    await requestPasswordReset(user.email);

    expect(sendMock.mock.calls.at(-1)?.[0]).toMatchObject({ sensitive: true });
  });

  it("does not turn a transient email-provider outage into an account-existence oracle", async () => {
    const user = await createTestUser("reset-provider-outage");
    const { requestPasswordReset } = await import("@/lib/auth/passwordReset");

    sendMock.mockRejectedValueOnce(new Error("email_provider_error"));

    // Same observable outcome (resolves, no throw) as the unknown-account
    // case above -- a caller cannot use a thrown error here to infer that
    // the account exists during a provider outage.
    await expect(requestPasswordReset(user.email)).resolves.toBeUndefined();

    // The token created before the failed send must not be left claimable
    // against a reset email the customer never actually received.
    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(0);
  });

  it("invalidates a previous unused token when a new one is requested for the same account", async () => {
    const user = await createTestUser("reset-request-twice");
    const { requestPasswordReset } = await import("@/lib/auth/passwordReset");

    await requestPasswordReset(user.email);
    await requestPasswordReset(user.email);

    const rows = await prisma.passwordResetToken.findMany({ where: { userId: user.id } });
    expect(rows).toHaveLength(1);
  });
});

describe("resetPasswordWithToken", () => {
  afterEach(() => {
    sendMock.mockClear();
  });

  it("updates the password and marks the token used, given a valid token", async () => {
    const user = await createTestUser("reset-apply");
    const { requestPasswordReset, resetPasswordWithToken } = await import("@/lib/auth/passwordReset");

    await requestPasswordReset(user.email);
    const rawToken = extractRawToken(lastSendInput().text);

    const outcome = await resetPasswordWithToken(rawToken, "a-brand-new-password");
    expect(outcome).toBe("reset");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.passwordHash).not.toBe(user.passwordHash);

    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    const tokenRow = await prisma.passwordResetToken.findUniqueOrThrow({ where: { tokenHash } });
    expect(tokenRow.usedAt).not.toBeNull();
  });

  it("rejects reusing an already-used token, and never touches the password on that second attempt", async () => {
    const user = await createTestUser("reset-reuse");
    const { requestPasswordReset, resetPasswordWithToken } = await import("@/lib/auth/passwordReset");

    await requestPasswordReset(user.email);
    const rawToken = extractRawToken(lastSendInput().text);

    await resetPasswordWithToken(rawToken, "first-new-password");
    const afterFirst = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });

    const secondOutcome = await resetPasswordWithToken(rawToken, "second-new-password");
    expect(secondOutcome).toBe("invalid_or_expired");

    const afterSecond = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(afterSecond.passwordHash).toBe(afterFirst.passwordHash);
  });

  it("rejects an expired token", async () => {
    const user = await createTestUser("reset-expired");
    const { resetPasswordWithToken } = await import("@/lib/auth/passwordReset");

    // Unique per run -- CI repeats this whole suite twice against the same
    // persistent DB specifically to catch a hardcoded fixture value like a
    // literal string here colliding with the previous run's leftover row.
    const rawToken = `expired-token-${randomUUID()}`;
    const tokenHash = createHash("sha256").update(rawToken).digest("hex");
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() - 1000) },
    });

    const outcome = await resetPasswordWithToken(rawToken, "a-brand-new-password");
    expect(outcome).toBe("invalid_or_expired");

    await expect(prisma.user.findUniqueOrThrow({ where: { id: user.id } })).resolves.toMatchObject({
      passwordHash: user.passwordHash,
    });
  });

  it("rejects a token that was never issued, without throwing", async () => {
    const { resetPasswordWithToken } = await import("@/lib/auth/passwordReset");
    await expect(resetPasswordWithToken("completely-made-up-token", "a-brand-new-password")).resolves.toBe(
      "invalid_or_expired",
    );
  });

  it("increments authVersion in the same transaction as the password change", async () => {
    const user = await createTestUser("reset-auth-version");
    expect(user.authVersion).toBe(0);

    const { requestPasswordReset, resetPasswordWithToken } = await import("@/lib/auth/passwordReset");
    await requestPasswordReset(user.email);
    const rawToken = extractRawToken(lastSendInput().text);

    await resetPasswordWithToken(rawToken, "a-brand-new-password");

    const updated = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(updated.authVersion).toBe(1);
  });
});

/**
 * The Credentials provider's JWT strategy has no persisted session row to
 * delete server-side (see lib/auth/customer.ts's top comment) -- authVersion
 * is the actual revocation mechanism, so its enforcement lives in the
 * session() callback itself. Testing that callback directly (rather than
 * driving a full NextAuth HTTP round-trip) exercises the exact logic
 * requireCustomer()/requireCustomerForPage() depend on.
 */
describe("session callback: password reset revokes pre-reset sessions", () => {
  afterEach(() => {
    sendMock.mockClear();
  });

  it("a session token issued before a reset is rejected after it, while a fresh sign-in still works", async () => {
    const user = await createTestUser("reset-session-revocation");
    const { authOptions } = await import("@/lib/auth/customer");
    const { requestPasswordReset, resetPasswordWithToken } = await import("@/lib/auth/passwordReset");

    const jwtCallback = authOptions.callbacks!.jwt!;
    const sessionCallback = authOptions.callbacks!.session!;

    // Simulate the JWT issued by the original sign-in, before any reset.
    const staleToken = await jwtCallback({
      token: {},
      user: { id: user.id, email: user.email, name: user.name, authVersion: user.authVersion },
    } as Parameters<typeof jwtCallback>[0]);

    const baseSession = { expires: new Date(Date.now() + 86_400_000).toISOString() };
    const sessionBeforeReset = (await sessionCallback({
      session: { ...baseSession, user: { id: "", email: user.email, name: user.name } },
      token: staleToken,
    } as Parameters<typeof sessionCallback>[0])) as Session;
    expect(sessionBeforeReset.user?.id).toBe(user.id);

    await requestPasswordReset(user.email);
    const rawToken = extractRawToken(lastSendInput().text);
    const outcome = await resetPasswordWithToken(rawToken, "a-brand-new-post-reset-password");
    expect(outcome).toBe("reset");

    // Same stale token as before the reset -- must now read as unauthenticated.
    const sessionAfterReset = (await sessionCallback({
      session: { ...baseSession, user: { id: "", email: user.email, name: user.name } },
      token: staleToken,
    } as Parameters<typeof sessionCallback>[0])) as Session;
    expect(sessionAfterReset.user).toBeUndefined();

    // A fresh sign-in after the reset picks up the new authVersion and works.
    const refreshedUser = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    const freshToken = await jwtCallback({
      token: {},
      user: { id: refreshedUser.id, email: refreshedUser.email, name: refreshedUser.name, authVersion: refreshedUser.authVersion },
    } as Parameters<typeof jwtCallback>[0]);
    const sessionWithFreshToken = (await sessionCallback({
      session: { ...baseSession, user: { id: "", email: user.email, name: user.name } },
      token: freshToken,
    } as Parameters<typeof sessionCallback>[0])) as Session;
    expect(sessionWithFreshToken.user?.id).toBe(user.id);
  });

  it("treats a legacy token with no authVersion as version 0, matching every pre-existing user's default", async () => {
    const user = await createTestUser("reset-legacy-token");
    const { authOptions } = await import("@/lib/auth/customer");
    const sessionCallback = authOptions.callbacks!.session!;

    const legacyToken = { sub: user.id } as Parameters<typeof sessionCallback>[0]["token"];
    const session = (await sessionCallback({
      session: {
        expires: new Date(Date.now() + 86_400_000).toISOString(),
        user: { id: "", email: user.email, name: user.name },
      },
      token: legacyToken,
    } as Parameters<typeof sessionCallback>[0])) as Session;

    expect(session.user?.id).toBe(user.id);
  });
});
