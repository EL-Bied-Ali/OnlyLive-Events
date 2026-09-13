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
  | "paid_but_unfulfillable"
  | "reconciliation_required";

const TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending_payment: ["paid", "failed", "cancelled", "paid_but_unfulfillable"],
  paid: ["refunded", "partially_refunded"],
  // A payment.succeeded event can still arrive after failed/cancelled
  // (the real PSP hasn't been chosen, so its actual event ordering/
  // idempotency guarantees are unknown — never assume this can't
  // happen). It resolves to "paid" (inventory could still be safely
  // fulfilled) or "reconciliation_required" (it couldn't) — see
  // lib/orders/fulfillment.ts and docs/PAYMENTS.md.
  failed: ["paid", "reconciliation_required"],
  cancelled: ["paid", "reconciliation_required"],
  refunded: [],
  partially_refunded: ["refunded"],
  paid_but_unfulfillable: ["refunded"],
  // A human resolves this by refunding the captured payment once no
  // fulfillment is possible; never transitions automatically.
  reconciliation_required: ["refunded"],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: OrderStatus, to: OrderStatus): void {
  if (!canTransition(from, to)) {
    throw new Error(`Illegal order status transition: ${from} -> ${to}`);
  }
}
