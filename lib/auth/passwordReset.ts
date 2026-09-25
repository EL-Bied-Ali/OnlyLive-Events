import "server-only";
import { randomBytes, createHash } from "crypto";
import { prisma } from "@/lib/db";
import { hashPassword } from "@/lib/auth/password";
import { getEmailProvider } from "@/lib/email";
import { absoluteAppUrl } from "@/lib/appUrl";

const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

function hashToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Always resolves the same way whether or not `email` has an account --
 * callers must never branch on this to decide what to tell the customer,
 * or the endpoint becomes an account-enumeration oracle. The raw token is
 * never persisted (only its SHA-256 hash is) and never logged; it exists
 * only in this function's stack and in the email sent to the customer.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email }, select: { id: true, email: true } });
  if (!user) return;

  const rawToken = randomBytes(32).toString("hex");
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MS);

  const resetToken = await prisma.$transaction(async (tx) => {
    // Hygiene, not a security boundary: each token is independently random
    // and hashed, so several valid ones existing at once isn't unsafe, but
    // there's no reason to let old unused ones linger once a new one is
    // requested.
    await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
    return tx.passwordResetToken.create({
      data: { userId: user.id, tokenHash, expiresAt },
      select: { id: true },
    });
  });

  // The fragment (#token=...) is never sent to the server -- browser/access
  // logs and history only ever see the bare path, unlike a query string.
  // The reset page reads it client-side and immediately scrubs it from the
  // visible URL.
  const resetUrl = absoluteAppUrl(`/reinitialiser-mot-de-passe#token=${rawToken}`);

  try {
    // Deliberately sent directly, not through the durable EmailOutbox: the
    // outbox pattern re-renders content from durable business state at send
    // time (see lib/email/notifications.ts), but a reset token's raw value
    // is by design never persisted anywhere to re-render from. A transient
    // provider failure here just means the customer can request again.
    await getEmailProvider().send({
      to: user.email,
      subject: "Réinitialisation de votre mot de passe OnlyLive",
      text: [
        "Vous avez demandé la réinitialisation de votre mot de passe OnlyLive.",
        "",
        `Cliquez sur ce lien pour choisir un nouveau mot de passe : ${resetUrl}`,
        "",
        "Ce lien expire dans 1 heure et ne peut être utilisé qu'une seule fois.",
        "",
        "Si vous n'êtes pas à l'origine de cette demande, ignorez cet email -- votre mot de passe actuel reste inchangé.",
      ].join("\n"),
      idempotencyKey: resetToken.id,
      sensitive: true,
    });
  } catch (error) {
    // A provider failure for a KNOWN account must be indistinguishable
    // from the unknown-account case above (both just return), or the
    // caller's HTTP status becomes an account-enumeration oracle: known +
    // outage -> would otherwise surface as a 500, unknown -> always 200.
    // The unusable token is deleted so it can't be claimed later against a
    // reset the customer never actually received.
    await prisma.passwordResetToken.delete({ where: { id: resetToken.id } }).catch(() => {});
    console.error("password_reset_email_send_failed", error instanceof Error ? error.message : error);
  }
}

export type ResetPasswordOutcome = "reset" | "invalid_or_expired";

class PasswordResetTokenInvalid extends Error {}

/**
 * Neutral on failure by design: "invalid_or_expired" covers not-found,
 * already-used, and expired alike, so a caller can't use the response to
 * probe which case it was.
 *
 * The claim (marking the token used) and the effect (updating the user's
 * password) run inside one transaction -- claiming it first in isolation
 * and updating the password afterward would let a crash in between leave
 * a token burned with the password never actually changed. `updateMany`'s
 * WHERE clause (usedAt IS NULL AND expiresAt in the future) is the atomic
 * compare-and-set that makes concurrent submissions of the same link only
 * ever let one succeed.
 */
export async function resetPasswordWithToken(rawToken: string, newPassword: string): Promise<ResetPasswordOutcome> {
  const tokenHash = hashToken(rawToken);
  const passwordHash = await hashPassword(newPassword);

  try {
    await prisma.$transaction(async (tx) => {
      const claim = await tx.passwordResetToken.updateMany({
        where: { tokenHash, usedAt: null, expiresAt: { gt: new Date() } },
        data: { usedAt: new Date() },
      });
      if (claim.count === 0) {
        throw new PasswordResetTokenInvalid();
      }

      const record = await tx.passwordResetToken.findUniqueOrThrow({
        where: { tokenHash },
        select: { userId: true },
      });
      // authVersion increments atomically alongside the password change --
      // not as a separate step -- so a crash between the two can never
      // leave the password changed with old sessions still trusted, or
      // sessions revoked with the password left unchanged. This is what
      // makes an already-authenticated session from before the reset stop
      // working: see the session() callback in lib/auth/customer.ts, which
      // compares a JWT's stored version against this column on every read.
      await tx.user.update({
        where: { id: record.userId },
        data: { passwordHash, authVersion: { increment: 1 } },
      });
    });
  } catch (error) {
    if (error instanceof PasswordResetTokenInvalid) return "invalid_or_expired";
    throw error;
  }

  return "reset";
}
