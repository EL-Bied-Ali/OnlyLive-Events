import { describe, expect, it } from "vitest";
import { registerSchema } from "@/lib/validation/auth";

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    email: "buyer@example.com",
    password: "a-strong-password",
    name: "Amine Bennani",
    phone: "0612345678",
    ...overrides,
  };
}

describe("registerSchema", () => {
  it("accepts a plausible Moroccan phone number", () => {
    const result = registerSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
  });

  it("accepts an international-format phone number", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "+212 6 12 34 56 78" }));
    expect(result.success).toBe(true);
  });

  it("rejects registration with no phone at all", () => {
    const withoutPhone: Record<string, unknown> = validPayload();
    delete withoutPhone.phone;
    const result = registerSchema.safeParse(withoutPhone);
    expect(result.success).toBe(false);
  });

  it("rejects an empty phone string", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "" }));
    expect(result.success).toBe(false);
  });

  it("rejects a phone that is too short to be real", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "123" }));
    expect(result.success).toBe(false);
  });

  it("rejects a phone containing letters", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "call-me-maybe" }));
    expect(result.success).toBe(false);
  });

  it("still enforces the pre-existing email/password/name rules unchanged", () => {
    expect(registerSchema.safeParse(validPayload({ email: "not-an-email" })).success).toBe(false);
    expect(registerSchema.safeParse(validPayload({ password: "short" })).success).toBe(false);
    expect(registerSchema.safeParse(validPayload({ name: "" })).success).toBe(false);
  });
});
