import { describe, expect, it } from "vitest";
import { generateValidationToken, ticketQrPayload } from "@/lib/tickets";

describe("ticket validation tokens", () => {
  it("generates URL-safe, sufficiently random, unguessable tokens", () => {
    const a = generateValidationToken();
    const b = generateValidationToken();

    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 24 random bytes base64url-encoded -> 32 characters, no padding.
    expect(a.length).toBe(32);
  });

  it("never derives the token from a sequential id or personal data", () => {
    const token = generateValidationToken();
    expect(token).not.toMatch(/^[0-9]+$/);
  });

  it("QR payload is exactly the opaque token — no other fields", () => {
    const token = generateValidationToken();
    const payload = ticketQrPayload(token);
    expect(payload).toBe(token);
    expect(payload).not.toMatch(/[{}:]/); // not a JSON blob carrying extra fields
  });
});
