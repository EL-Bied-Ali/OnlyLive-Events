import { describe, expect, it } from "vitest";
import { buildFakeWebhookForwardHeaders } from "@/lib/payments/fakeWebhookForwarding";

describe("buildFakeWebhookForwardHeaders — Vercel Deployment Protection bypass", () => {
  it("omits x-vercel-protection-bypass when no bypass secret is configured", () => {
    const headers = buildFakeWebhookForwardHeaders("sig123", undefined);

    expect(headers).toEqual({
      "content-type": "application/json",
      "x-onlylive-fake-signature": "sig123",
    });
    expect(headers).not.toHaveProperty("x-vercel-protection-bypass");
  });

  it("attaches x-vercel-protection-bypass with the exact configured value when set", () => {
    const headers = buildFakeWebhookForwardHeaders("sig123", "the-real-bypass-secret");

    expect(headers).toEqual({
      "content-type": "application/json",
      "x-onlylive-fake-signature": "sig123",
      "x-vercel-protection-bypass": "the-real-bypass-secret",
    });
  });
});
