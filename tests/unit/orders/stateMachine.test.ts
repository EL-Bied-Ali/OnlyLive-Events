import { describe, expect, it } from "vitest";
import { assertTransition, canTransition } from "@/lib/orders/stateMachine";

describe("order status state machine", () => {
  it("allows the legal transitions out of pending_payment", () => {
    expect(canTransition("pending_payment", "paid")).toBe(true);
    expect(canTransition("pending_payment", "failed")).toBe(true);
    expect(canTransition("pending_payment", "cancelled")).toBe(true);
    expect(canTransition("pending_payment", "paid_but_unfulfillable")).toBe(true);
  });

  it("rejects illegal transitions", () => {
    expect(canTransition("paid", "pending_payment")).toBe(false);
    expect(canTransition("failed", "paid")).toBe(false);
    expect(canTransition("cancelled", "paid")).toBe(false);
    expect(canTransition("refunded", "paid")).toBe(false);
  });

  it("allows refunding a paid or paid_but_unfulfillable order", () => {
    expect(canTransition("paid", "refunded")).toBe(true);
    expect(canTransition("paid", "partially_refunded")).toBe(true);
    expect(canTransition("paid_but_unfulfillable", "refunded")).toBe(true);
  });

  it("treats terminal states as terminal", () => {
    expect(canTransition("failed", "cancelled")).toBe(false);
    expect(canTransition("refunded", "paid_but_unfulfillable")).toBe(false);
  });

  it("assertTransition throws on an illegal transition and is silent on a legal one", () => {
    expect(() => assertTransition("pending_payment", "paid")).not.toThrow();
    expect(() => assertTransition("paid", "pending_payment")).toThrow(/Illegal order status transition/);
  });
});
