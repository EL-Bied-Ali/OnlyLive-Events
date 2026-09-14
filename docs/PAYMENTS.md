# Payments

**No Moroccan payment provider has been selected yet.** Everything below
describes the abstraction and the fake/sandbox implementation used for
development — never a real PSP's API. When a provider is chosen, its
adapter is implemented from its official documentation and registered in
`lib/payments/index.ts::getPaymentProvider()`; nothing else in the app
should need to change.

## `PaymentProvider` interface (`lib/payments/provider.ts`)

```ts
interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
```

- `createPayment` starts a payment and returns a `redirectUrl` (a real PSP:
  its hosted checkout URL) plus a `providerPaymentId`.
- `parseWebhook` takes the raw request body and headers, verifies the
  provider's signature, and returns a normalized event
  (`payment.succeeded` / `payment.failed` / `payment.cancelled` /
  `refund.succeeded`) with `amountCents`, `currency`, and
  `signatureValid: boolean` — the webhook route never trusts
  `amountCents`/`currency` without comparing them against the `Payment`
  row first (see Amount/currency verification below).
- `refund` is wired into the admin dashboard — see Refunds below.

## Fake payments are blocked outside deliberate dev/test use

`lib/payments/index.ts::isFakePaymentsAllowed()` returns `false` whenever
`NODE_ENV=production` unless `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true` is
also set. This is enforced in four places:

1. `getPaymentProvider()` throws if `PAYMENT_PROVIDER=fake` and fake
   payments aren't allowed.
2. `instrumentation.ts` calls `getPaymentProvider()` once at server boot,
   so a misconfigured production deployment **fails to start** instead of
   only failing on the first webhook.
3. `/pay/fake/[paymentId]` (the sandbox checkout page) calls `notFound()`
   when disabled.
4. `POST /api/pay/fake/[paymentId]/simulate` and
   `POST /api/payments/webhook/fake` both return 404 immediately when
   disabled, before doing anything else (including before requiring a
   session).

`ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true` is only ever set for a
deliberate non-production-traffic run — e.g. the Playwright e2e suite,
which drives a real `next start` (always `NODE_ENV=production`) and sets
this in `playwright.config.ts`'s `webServer.env`. It must never be set for
a real deployment. See `tests/unit/payments/productionGuard.test.ts`.

## Order/payment state machine and event-transition policy

`Order.status`: `pending_payment → paid | failed | cancelled |
paid_but_unfulfillable`; `paid | paid_but_unfulfillable → refunded |
partially_refunded`; `failed | cancelled → paid | reconciliation_required`
(see Reconciliation below); `reconciliation_required → refunded`. See
`lib/orders/stateMachine.ts` for the full, independently unit-tested
transition table — that module is a pure documentation/validation layer;
the actual concurrency-safe enforcement is the guarded SQL
`UPDATE ... WHERE status = 'pending_payment'` in
`lib/orders/fulfillment.ts`, which is both the row lock and the guard.

`Payment.status`: `pending → awaiting_payment → paid | failed |
cancelled`; `paid → refunded | partially_refunded`.

**Policy: `Payment.status` only changes on a real transition, and never
hides evidence that money was captured.** The webhook route
(`app/api/payments/webhook/fake/route.ts`) only writes `Payment.status`
when `confirmOrderPayment`/`failOrderPayment` return an outcome that
actually applied (`paid`, `paid_but_unfulfillable`,
`reconciliation_required`, `failed`, `cancelled`) — never when they
return `already_handled` (the order had already left `pending_payment`
via a *different, non-contradictory* path) or `order_not_found`. This is
what makes these all safe, in any order or concurrently:

- `payment.succeeded` then `payment.failed` (or vice versa) for the same
  payment — whichever arrives first wins. If `succeeded` wins, a later
  `failed` is acknowledged (200) but is a no-op. If `failed` wins
  first, a later `succeeded` is **not** treated as a no-op — see
  Reconciliation below, since that specific ordering is exactly the
  "customer charged, order marked failed" risk this policy exists to
  close.
- Two differently-IDed events for the same logical payment.
- Simultaneous `succeeded`/`failed` deliveries — the Payment row lock
  (see Atomicity below) serializes them; exactly one final outcome is
  reached deterministically (see Reconciliation).

`paid_but_unfulfillable` exists because a hold can expire (and its stock
get resold) in the window between "customer clicks pay" and "provider
confirms payment" while the order was still `pending_payment` — see
`lib/orders/checkout.ts`'s checkout-expiry extension, which shrinks but
cannot eliminate this race. When it happens, the customer's money was
captured (`Payment.status = 'paid'`) but no tickets are generated; this is
intentional (never oversell) but currently has **no automated
resolution** — an admin must notice it (surfaced in the dashboard's
attention metrics) and manually issue a full refund from the order
detail page; there is no automatic trigger yet (tracked in TASKS.md).

## Reconciliation: a contradictory payment.succeeded after failed/cancelled

**The real payment provider has not been selected yet.** The policy below
is a conservative stopgap based on "never assume a payment lifecycle
transition is impossible" and "never silently drop evidence that money
was captured" — it is **not** derived from any real PSP's documented
event guarantees. Once a provider is chosen, revisit this against its
actual official lifecycle documentation (can a `succeeded` event really
follow a `failed`/`cancelled` one for that provider? is a later event
authoritative? is there a dispute/chargeback flow that interacts with
this?) rather than assuming this heuristic still applies.

If a validly-signed, amount/currency-matching `payment.succeeded` event
arrives for an order the app had already settled as `failed` or
`cancelled`, `confirmOrderPayment` routes it to
`reconcileContradictorySuccess` (`lib/orders/fulfillment.ts`) instead of
treating it as `already_handled`:

1. It re-checks, atomically (locking each affected `TicketCategory`'s
   `Inventory` row, same pattern as `createHold`), whether the order's
   original items can still be fulfilled from current stock. The
   original `Reservation` stays `cancelled` (it accurately was, at the
   time of the earlier failure) — fulfillment here consumes fresh
   inventory directly into `sold_quantity`, it does not reuse the old
   hold.
2. **If fulfillable**: tickets are generated and the order becomes
   `paid` — a captured payment is never left stranded on a dead order
   when avoidable.
3. **If not** (the stock was resold in the meantime): the order becomes
   `reconciliation_required` — no ticket is generated (never oversell),
   and a human must resolve it (manually fulfil if stock frees up, or
   refund). This is a terminal, human-only state: it is never
   re-attempted automatically by a later event.
4. Either way, `Payment.status` is set to `paid` (money was captured —
   this is a fact, independent of whether the order could be fulfilled)
   and an `AuditLog` entry is written
   (`payment.contradictory_success_reconciled_and_fulfilled` or
   `payment.contradictory_success_requires_reconciliation`).

See `tests/integration/payment-webhook.test.ts` for: failed→succeeded
while still fulfillable, failed→succeeded after the stock was resold,
cancelled→succeeded, and the audit records both paths create.

## Atomicity: claiming and processing a webhook event

The entire webhook handler — locking the `Payment` row, claiming the
event, the amount/currency check, the order-row-locked fulfillment
transition, and marking the event `processedAt` — runs inside **one**
database transaction (`prisma.$transaction`). This matters specifically
because "claim the event" (the `payment_events` insert) and "apply it"
(the order/payment state change) must succeed or fail together: if they
were separate transactions, a crash between them would leave a
claimed-but-unprocessed event that a provider retry would see as
`ON CONFLICT` and skip — silently losing the payment confirmation.

As defense in depth against a `payment_events` row that predates this
atomicity guarantee (or any other anomaly) existing with `processedAt`
still `null`, the handler checks that column on a conflict: a `null`
means the prior attempt never finished, and the event is reprocessed
rather than silently acknowledged as a duplicate. See
`tests/integration/payment-webhook.test.ts`'s "reprocesses a
payment_events row that was claimed but never marked processed" test.

Locking the `Payment` row itself (`SELECT ... FOR UPDATE`) at the top of
the transaction is additional defense in depth alongside the
`payment_events` unique constraint and the order-row lock inside
`confirmOrderPayment`/`failOrderPayment`: it fully serializes concurrent
webhook deliveries for the *same* payment even when they carry different
event ids.

### Reclaim consistency

Reclaiming a `payment_events` row (existing row, `processedAt` still
null) only reprocesses it if the current request agrees with what was
originally claimed on every immutable fact:
`existing.paymentId === payment.id` (the currently-resolved Payment
matches), `existing.eventType === event.type`, the original attempt's
`signatureValid` was **not** `false` (an event id once seen with an
invalid signature can never be "upgraded" to valid processing by a later
attempt — that would let a forgery attempt succeed just by resending the
same id once the secret is guessed/leaked), and the original raw
payload's `amountCents`/`currency` (if present) match the current event's.
Any mismatch is rejected (`409 EVENT_COLLISION`), audited
(`payment.webhook_event_collision`), and — critically — the existing
row's `rawPayload`/`signatureValid` are left untouched, so the historical
record of the anomaly is never overwritten by whatever the colliding
attempt claims. See `tests/integration/payment-webhook.test.ts`.

## Amount/currency verification

Before any fulfillment logic runs, the webhook handler compares the
event's `amountCents`/`currency` against the `Payment` row's own values.
A mismatch — even with a validly-signed event — is logged to `AuditLog`
(`action: "payment.amount_mismatch"`), the `payment_events` row is marked
processed (so it isn't retried forever), and the handler returns
`409 AMOUNT_MISMATCH` without generating any ticket or changing
`Order`/`Payment` status. See `tests/integration/payment-webhook.test.ts`.

## Checkout idempotency

`lib/orders/checkout.ts::startCheckout` guarantees **at most one** Order
per Reservation, **and** at most one call to `provider.createPayment` per
Payment — two distinct guarantees, both needed:

**One Order per Reservation** (`ensurePendingOrderAndPayment`):
- Locks the `Reservation` row (`FOR UPDATE`) first, so concurrent
  checkout requests for the *same* reservation fully serialize — only
  the first creates an Order/Payment; every other one (sequential retry
  or concurrent race) takes the "already checked out" branch.
- `order_items.reservation_id` carries a database `UNIQUE` constraint as
  defense in depth, independent of the application-level lock.
- **Expiry guard**: if provider initialization never completed for the
  existing Payment (no `redirectUrl` yet) and the reservation has since
  expired — checked directly against `expires_at`, the same lazy-expiry
  idiom as `lib/inventory.ts`, so this doesn't depend on the background
  sweep having run — this throws `409 HOLD_EXPIRED` rather than letting
  the caller start a brand-new provider payment for stock that may no
  longer be reserved. If initialization *did* already complete, the
  stored redirect is still returned regardless of expiry (the customer
  may already have a real PSP session open).

**One provider call per Payment** (`claimAndInitializeProvider`): a
locked database row alone doesn't stop this — two concurrent callers can
both pass "no redirectUrl yet" and both call the provider before either
one writes back. `payments.provider_init_at` is a durable claim:
- A caller atomically claims it with a guarded
  `UPDATE ... WHERE provider_payment_id IS NULL AND (provider_init_at IS
  NULL OR provider_init_at < now() - <timeout>)`. Only the winner calls
  `provider.createPayment`; every other concurrent caller polls briefly
  (checking whether the winner has since stored a `redirectUrl`) instead
  of calling the provider itself.
- The claim and the provider call are separate statements — no database
  transaction spans the network I/O.
- A stale claim (the claimant crashed or the request timed out) expires
  after the timeout window and can be reclaimed by the next caller,
  instead of blocking that Payment forever.
- `idempotencyKey` is generated once when the Payment row is created and
  is never regenerated across claims/retries — every attempt presents
  the provider the same key.
- On failure, the claim is released immediately (not left to expire) so
  the very next retry can attempt again right away, and the
  already-committed Order/Payment are left exactly as they were
  (`pending_payment` / `awaiting_payment`, no `providerPaymentId`) — a
  second Order is never created because of a provider failure.

See `tests/integration/checkout-idempotency.test.ts` for sequential
retry, concurrent retry (asserting `provider.createPayment` is called
exactly once, not merely that one database Order exists),
provider-failure-then-retry, and expired-retry-after-provider-failure
scenarios.

## Refunds

`lib/orders/refund.ts::initiateRefund` — admin-initiated (`admin`/
`super_admin` only; `support` is read-only), full or partial:

1. Locks the `Payment` and `Order` rows (`FOR UPDATE`) for the entire
   operation, provider call included. This differs from checkout's
   `provider_init_at` claim-then-verify split: it's safe here because
   `FakeProvider.refund()` is synchronous local work with no real network
   I/O, and refunds are a low-frequency, human-driven action rather than
   high-concurrency checkout traffic. Holding the lock across a real PSP's
   HTTP call would block other work against that payment for the
   round-trip — if that matters once a real provider is integrated,
   switch this to the same claim-then-verify split as
   `lib/orders/checkout.ts`.
2. Rejects (`409 PAYMENT_NOT_REFUNDABLE`) unless `Payment.status` is
   `paid` or `partially_refunded`. Rejects (`409
   REFUND_EXCEEDS_REMAINING`) an amount greater than `amountCents` minus
   the sum of that payment's already-`succeeded` refunds.
3. A partial refund (amount less than the full remaining balance) is only
   a legal transition from `paid`/`partially_refunded` — see
   `lib/orders/stateMachine.ts`. An order in `paid_but_unfulfillable` or
   `reconciliation_required` has no fulfilled tickets to partially
   retain, so only a full refund is accepted there (`409
   PARTIAL_REFUND_NOT_ALLOWED` otherwise).
4. On a full refund, every ticket still `valid` is cancelled and its
   category's `sold_quantity` is released for resale. A ticket already
   `used` is left untouched — the seat was consumed and is never resold
   regardless of refund. A partial refund never touches tickets or
   inventory, since which specific tickets a partial amount corresponds
   to isn't specified by the current (order/payment-level, not
   per-ticket) admin UI.
5. **The provider call is never allowed to `throw` out of the transaction
   callback.** Doing so would roll back this function's own bookkeeping
   (marking the `Refund` row `failed`, writing the audit log) along with
   everything else — the transaction would commit as if the attempt never
   happened, silently discarding evidence of it. Failure is instead
   returned as a value from the transaction and turned into a `502
   PROVIDER_REFUND_FAILED` only after that transaction has committed with
   the `Refund` row correctly left `failed`. A later retry attempt is not
   blocked by the earlier failure.
6. `RefundInput.idempotencyKey` (the `Refund` row's own id) is passed to
   `provider.refund()` — `FakeProvider` ignores it, but a real adapter
   must forward it to the PSP so a retried refund request can never
   double-refund.

See `tests/integration/refunds.test.ts`: full refund, partial refund
(tickets/inventory untouched), a second partial refund completing the
balance (only then are tickets cancelled), exceeding the remaining
balance, refunding a never-paid or already-fully-refunded payment,
partial refund rejected on `paid_but_unfulfillable`, an already-`used`
ticket never cancelled/double-released, a provider failure leaving
state unchanged and auditable followed by a successful retry, and
concurrent refund attempts on the same payment serializing so their
total never exceeds the paid amount.

A successful refund also triggers `lib/email/notifications.ts::sendRefundConfirmationEmail`,
after the transaction commits — see docs/ARCHITECTURE.md's transactional
email section.

## Hold cancellation vs. checkout

Once a reservation's checkout has started (`reservation.order_id` is
set), `lib/inventory.ts::releaseHold` refuses to cancel it
(`409 CHECKOUT_IN_PROGRESS`) — a payment may still be in flight, and
releasing the stock could let it be resold to someone else while the
original payment still succeeds (exactly the race `paid_but_unfulfillable`
exists to catch; better to prevent it here than rely on that fallback).
Order-level cancellation (with any refund a started payment would need)
is a separate, not-yet-built flow. See
`tests/integration/hold-cancellation.test.ts`.

## FakeProvider (`lib/payments/fakeProvider.ts`)

Simulates a hosted-checkout PSP without inventing a real API:

1. `createPayment` never makes an external call — it points `redirectUrl`
   at the app's own `/pay/fake/[paymentId]` page.
2. That page's "Simulate success/failure" buttons call
   `POST /api/pay/fake/[paymentId]/simulate` (customer-session-gated, a
   dev/sandbox convenience — a real PSP's webhook has no such gate).
3. That route builds the exact webhook payload a provider would send
   (`{eventId, providerPaymentId, type, amountCents, currency}`), signs it
   with HMAC-SHA256 using `FAKE_PSP_WEBHOOK_SECRET` (a server-only secret,
   never sent to the browser), and **actually POSTs it** to the real
   `POST /api/payments/webhook/fake` route over HTTP.
4. That route is the genuine verification path described above:
   signature check → amount/currency check → idempotent atomic claim →
   order-row-locked transition → ticket generation.

Because step 4 is real code exercised end-to-end (not stubbed), swapping
in a real PSP later means implementing steps 1–3 against that PSP's actual
API/webhook format — step 4's logic is reused unchanged.

## Card data

OnlyLive's app **never** collects or stores raw payment card data and
never implements a custom card-processing system. Card entry happens
entirely on the eventual PSP's PCI-DSS-compliant hosted checkout or
equivalent secure element — this repo only ever sees a `redirectUrl` and,
later, a webhook confirmation.

## Open decisions

- Which Moroccan PSP to integrate (CMI, HPS/Onepay, or another —
  **undecided**, do not build against any of them speculatively).
- Automated (rather than admin-triggered) handling of
  `paid_but_unfulfillable`/`reconciliation_required` orders.
