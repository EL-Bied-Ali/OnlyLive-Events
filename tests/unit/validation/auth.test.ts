import { describe, expect, it } from "vitest";
import { registerSchema, updatePhoneSchema } from "@/lib/validation/auth";

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
  it("accepts a plausible Moroccan phone number and stores its canonical E.164 form", () => {
    const result = registerSchema.safeParse(validPayload());
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe("+212612345678");
  });

  it("accepts an international-format phone number", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "+212 6 12 34 56 78" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.phone).toBe("+212612345678");
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

  it("rejects punctuation-only input that merely satisfies the character-count minimum", () => {
    expect(registerSchema.safeParse(validPayload({ phone: "++++++++" })).success).toBe(false);
    expect(registerSchema.safeParse(validPayload({ phone: "()()()()" })).success).toBe(false);
    expect(registerSchema.safeParse(validPayload({ phone: "........" })).success).toBe(false);
  });

  it("rejects a formatted string with too few actual digits", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "12 34 56" }));
    expect(result.success).toBe(false);
  });

  it("rejects a value that merely looks phone-shaped but isn't a real Moroccan or country-coded number", () => {
    // Regression test (independent audit, GPT): the previous rule only
    // checked for phone-like characters plus an 8-15 digit count, so a
    // value like this passed registration/update but was then rejected by
    // ChariPay's adapter at payment time — with no way for the customer to
    // fix it. Both now share lib/validation/phone.ts's normalizePhone.
    const result = registerSchema.safeParse(validPayload({ phone: "1234567890" }));
    expect(result.success).toBe(false);
  });

  it("accepts a spaced local Moroccan number", () => {
    const result = registerSchema.safeParse(validPayload({ phone: "06 12 34 56 78" }));
    expect(result.success).toBe(true);
  });

  it("still enforces the pre-existing email/password/name rules unchanged", () => {
    expect(registerSchema.safeParse(validPayload({ email: "not-an-email" })).success).toBe(false);
    expect(registerSchema.safeParse(validPayload({ password: "short" })).success).toBe(false);
    expect(registerSchema.safeParse(validPayload({ name: "" })).success).toBe(false);
  });
});

describe("updatePhoneSchema", () => {
  // Shares phoneSchema with registerSchema — this only re-checks that the
  // shared export is actually wired up correctly, not the validation rules
  // themselves (already exhaustively covered above).
  it("accepts the same phone formats registerSchema accepts", () => {
    expect(updatePhoneSchema.safeParse({ phone: "0612345678" }).success).toBe(true);
    expect(updatePhoneSchema.safeParse({ phone: "+212 6 12 34 56 78" }).success).toBe(true);
  });

  it("rejects the same invalid formats registerSchema rejects", () => {
    expect(updatePhoneSchema.safeParse({ phone: "" }).success).toBe(false);
    expect(updatePhoneSchema.safeParse({ phone: "123" }).success).toBe(false);
    expect(updatePhoneSchema.safeParse({ phone: "++++++++" }).success).toBe(false);
    expect(updatePhoneSchema.safeParse({ phone: "1234567890" }).success).toBe(false);
  });

  it("rejects a missing phone field", () => {
    expect(updatePhoneSchema.safeParse({}).success).toBe(false);
  });
});
