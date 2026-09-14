import { describe, expect, it } from "vitest";
import { ConsoleEmailProvider } from "@/lib/email/fakeProvider";
import { getEmailProvider } from "@/lib/email";

describe("ConsoleEmailProvider", () => {
  it("returns a unique fake message id per send, without throwing or making a network call", async () => {
    const provider = new ConsoleEmailProvider();
    const first = await provider.send({ to: "a@test.onlylive.ma", subject: "Hi", text: "Body" });
    const second = await provider.send({ to: "a@test.onlylive.ma", subject: "Hi", text: "Body" });
    expect(first.providerMessageId).not.toBe(second.providerMessageId);
    expect(first.providerMessageId).toMatch(/^console_/);
  });
});

describe("getEmailProvider", () => {
  it("defaults to the console provider", () => {
    expect(getEmailProvider().name).toBe("console");
  });
});
