import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import { getEmailProvider, isConsoleEmailAllowed } from "@/lib/email";

describe("ConsoleEmailProvider", () => {
  it("returns a unique fake message id per send, without throwing or making a network call", async () => {
    const provider = new ConsoleEmailProvider();
    const first = await provider.send({ to: "a@test.onlylive.ma", subject: "Hi", text: "Body", idempotencyKey: "k1" });
    const second = await provider.send({ to: "a@test.onlylive.ma", subject: "Hi", text: "Body", idempotencyKey: "k2" });
    expect(first.providerMessageId).not.toBe(second.providerMessageId);
    expect(first.providerMessageId).toMatch(/^console_/);
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
});
