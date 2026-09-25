import { createHash, randomUUID } from "crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
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
});
