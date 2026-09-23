import { describe, expect, it } from "vitest";
import { classifyCheckoutNavigation } from "@/lib/payments/redirect";

describe("checkout redirect classification", () => {
  it("keeps relative fake-provider routes inside the Next.js app", () => {
    expect(classifyCheckoutNavigation("/pay/fake/payment-1")).toEqual({
      kind: "internal",
      url: "/pay/fake/payment-1",
    });
  });

  it("uses external navigation for absolute HTTPS PSP checkout URLs", () => {
    expect(classifyCheckoutNavigation("https://checkout.charipay.example/session/123")).toEqual({
      kind: "external",
      url: "https://checkout.charipay.example/session/123",
    });
  });

  it("rejects non-HTTPS and credential-bearing external destinations", () => {
    expect(() => classifyCheckoutNavigation("http://checkout.example/session/123")).toThrow(/HTTPS/);
    expect(() => classifyCheckoutNavigation("https://user:pass@checkout.example/session/123")).toThrow(/credentials/);
  });
});
