import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/validation/phone";

describe("normalizePhone", () => {
  it("normalizes a local Moroccan mobile number to E.164", () => {
    expect(normalizePhone("0612345678")).toBe("+212612345678");
    expect(normalizePhone("06 12 34 56 78")).toBe("+212612345678");
  });

  it("normalizes a 00-prefixed international number", () => {
    expect(normalizePhone("00212612345678")).toBe("+212612345678");
  });

  it("normalizes a bare-212 number", () => {
    expect(normalizePhone("212612345678")).toBe("+212612345678");
  });

  it("passes through an already-E.164 number unchanged", () => {
    expect(normalizePhone("+212612345678")).toBe("+212612345678");
  });

  it("returns null for a plausible-looking but unrecognized number", () => {
    // Same shape (10 digits, allowed characters) as a valid Moroccan mobile,
    // but not a Moroccan mobile prefix (0-5/6/7) and not country-coded —
    // this is exactly the class of value the old, separately-maintained
    // schema regex used to accept and ChariPay's adapter used to reject.
    expect(normalizePhone("1234567890")).toBeNull();
  });

  it("returns null for missing or empty input", () => {
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone("")).toBeNull();
  });

  it("returns null for non-phone characters", () => {
    expect(normalizePhone("call-me-maybe")).toBeNull();
    expect(normalizePhone("++++++++")).toBeNull();
  });
});
