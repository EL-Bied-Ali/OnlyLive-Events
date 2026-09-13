/**
 * Pure order-status transition table. This is intentionally decoupled
 * from the database: the real enforcement of "only one transition wins
 * under concurrency" is the guarded SQL `UPDATE ... WHERE status = $x`
 * used in lib/orders/fulfillment.ts (the row lock + guard IS the
 * concurrency control). This module exists so the legal-transition graph
 * itself is documented once and independently unit-testable.
 */
export type OrderStatus =
  | "pending_payment"
  | "paid"
  | "failed"
  | "cancelled"
  | "refunded"
  | "partially_refunded"
  | "paid_but_unfulfillable";

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["paid", "failed", "cancelled", "paid_but_unfulfillable"],
  paid: ["refunded", "partially_refunded"],
  failed: [],
  cancelled: [],
  refunded: [],
  partially_refunded: ["refunded"],
  paid_but_unfulfillable: ["refunded"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order status transition: ${from} -> ${to}`);
  }
}
