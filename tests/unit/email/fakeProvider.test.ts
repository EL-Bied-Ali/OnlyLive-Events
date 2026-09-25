import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import { getEmailProvider, isConsoleEmailAllowed, isResendTestRecipientAllowed } from "@/lib/email";

describe("ConsoleEmailProvider", () => {
  it("returns a unique fake message id per send, without throwing or making a network call", async () => {
    const provider = new ConsoleEmailProvider();
    const first = await provider.send({ to: "a@test.onlylive.ma", subject: "Hi", text: "Body", idempotencyKey: "k1" });
    const second = await provider.send({ to: "a@test.onlylive.ma", subject: "Hi", text: "Body", idempotencyKey: "k2" });
    expect(first.providerMessageId).not.toBe(second.providerMessageId);
    expect(first.providerMessageId).toMatch(/^console_/);
  });

  it("never logs recipient, subject, or body for a sensitive email (e.g. a password-reset link)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const provider = new ConsoleEmailProvider();
      const rawToken = "super-secret-raw-reset-token-must-not-leak";
      await provider.send({
        to: "victim@test.onlylive.ma",
        subject: "Réinitialisation de votre mot de passe OnlyLive",
        text: `Cliquez ici : https://onlylive.ma/reinitialiser-mot-de-passe#token=${rawToken}`,
        idempotencyKey: "sensitive-1",
        sensitive: true,
      });

      const loggedOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(loggedOutput).not.toContain(rawToken);
      expect(loggedOutput).not.toContain("victim@test.onlylive.ma");
      expect(loggedOutput).not.toContain("Réinitialisation de votre mot de passe");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("still logs recipient/subject/body for a non-sensitive email", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const provider = new ConsoleEmailProvider();
      await provider.send({
        to: "buyer@test.onlylive.ma",
        subject: "Confirmation de commande",
        text: "Merci pour votre achat",
        idempotencyKey: "normal-1",
      });

      const loggedOutput = logSpy.mock.calls.map((call) => call.join(" ")).join("\n");
      expect(loggedOutput).toContain("buyer@test.onlylive.ma");
      expect(loggedOutput).toContain("Confirmation de commande");
    } finally {
      logSpy.mockRestore();
    }
  });
});

describe("getEmailProvider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defaults to the console provider", () => {
    expect(getEmailProvider().name).toBe("console");
  });

  it("allows the console provider outside production regardless of the opt-in flag", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("ALLOW_CONSOLE_EMAIL_IN_PRODUCTION", "");
    expect(isConsoleEmailAllowed()).toBe(true);
    expect(() => getEmailProvider()).not.toThrow();
  });

  it("refuses the console provider in production without the explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_CONSOLE_EMAIL_IN_PRODUCTION", "");
    expect(isConsoleEmailAllowed()).toBe(false);
    expect(() => getEmailProvider()).toThrow(/cannot be used in production/);
  });

  it("allows the console provider in production only with the explicit opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ALLOW_CONSOLE_EMAIL_IN_PRODUCTION", "true");
    expect(isConsoleEmailAllowed()).toBe(true);
    expect(() => getEmailProvider()).not.toThrow();
  });

  it("resolves the Resend provider only when its required config is present", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM_EMAIL", "");
    expect(() => getEmailProvider()).toThrow(/RESEND_API_KEY/);

    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "tickets@onlylive.test");
    expect(getEmailProvider().name).toBe("resend");
  });

  it("allows normal Resend delivery in Vercel Production when no test redirect is configured", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "tickets@onlylive.test");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");

    expect(getEmailProvider().name).toBe("resend");
  });

  it("allows the Resend test-recipient redirect on the standard Vercel Preview target", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_TARGET_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");

    expect(isResendTestRecipientAllowed()).toBe(true);
    expect(getEmailProvider().name).toBe("resend");
  });

  it("refuses the Resend test-recipient redirect on Vercel Production", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "production");
    vi.stubEnv("VERCEL_TARGET_ENV", "production");
    vi.stubEnv("NODE_ENV", "production");

    expect(isResendTestRecipientAllowed()).toBe(false);
    expect(() => getEmailProvider()).toThrow(/standard Vercel Preview target/);
  });

  it("refuses the Resend test-recipient redirect on a Vercel custom target", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_TARGET_ENV", "staging");
    vi.stubEnv("NODE_ENV", "production");

    expect(isResendTestRecipientAllowed()).toBe(false);
    expect(() => getEmailProvider()).toThrow(/standard Vercel Preview target/);
  });

  it("refuses the Resend test-recipient redirect in non-Vercel production", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("NODE_ENV", "production");

    expect(isResendTestRecipientAllowed()).toBe(false);
    expect(() => getEmailProvider()).toThrow(/development\/test runtime/);
  });

  it("fails closed when non-Vercel runtime markers are missing or unknown", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("NODE_ENV", "");

    expect(isResendTestRecipientAllowed()).toBe(false);
    expect(() => getEmailProvider()).toThrow(/development\/test runtime/);

    vi.stubEnv("NODE_ENV", "staging");
    expect(isResendTestRecipientAllowed()).toBe(false);
    expect(() => getEmailProvider()).toThrow(/development\/test runtime/);
  });

  it("allows the Resend test-recipient redirect in local development", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("NODE_ENV", "development");

    expect(isResendTestRecipientAllowed()).toBe(true);
    expect(getEmailProvider().name).toBe("resend");
  });

  it("allows the Resend test-recipient redirect in local tests", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "onboarding@resend.dev");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "owner@example.com");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("NODE_ENV", "test");

    expect(isResendTestRecipientAllowed()).toBe(true);
    expect(getEmailProvider().name).toBe("resend");
  });

  it("requires a test recipient for resend.dev regardless of sender-domain case", () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_onlylive");
    vi.stubEnv("RESEND_FROM_EMAIL", "ONBOARDING@RESEND.DEV");
    vi.stubEnv("RESEND_TEST_RECIPIENT", "");
    vi.stubEnv("VERCEL_ENV", "preview");
    vi.stubEnv("VERCEL_TARGET_ENV", "preview");
    vi.stubEnv("NODE_ENV", "production");

    expect(() => getEmailProvider()).toThrow(/requires RESEND_TEST_RECIPIENT/);
  });
});
