import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChariPayProvider } from "@/lib/payments/charipayProvider";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("ChariPay webhook secret rotation", () => {
  it("accepts X-CHARI-SIGNATURE-NEXT signed by the next secret during the grace window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET", "old-placeholder-secret");
    vi.stubEnv("CHARIPAY_WEBHOOK_SECRET_NEXT", "new-placeholder-secret");

    const rawBody = JSON.stringify({ Amount: 10, metadata: { onlylivePaymentId: "payment-1" } });
    const timestamp = String(Date.now());
    const nextSignature = crypto
      .createHmac("sha256", "new-placeholder-secret")
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    const parsed = await new ChariPayProvider().parseWebhook({
      rawBody,
      headers: {
        "x-chari-timestamp": timestamp,
        "x-chari-signature": "00".repeat(32),
        "x-chari-signature-next": nextSignature,
        "chari-event-id": "event-rotation",
        "chari-event-type": "payment.succeeded",
      },
    });

    expect(parsed.signatureValid).toBe(true);
  });
});
