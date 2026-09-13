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
- `refund` is schema-ready (`Refund` model) but not wired into any flow
  yet.

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
partially_refunded`. See `lib/orders/stateMachine.ts` for the full,
independently unit-tested transition table — that module is a pure
documentation/validation layer; the actual concurrency-safe enforcement is
the guarded SQL `UPDATE ... WHERE status = 'pending_payment'` in
`lib/orders/fulfillment.ts`, which is both the row lock and the guard.

`Payment.status`: `pending → awaiting_payment → paid | failed |
cancelled`; `paid → refunded | partially_refunded`.

**Policy: `Payment.status` only changes on a real transition.** The
webhook route (`app/api/payments/webhook/fake/route.ts`) only writes
`Payment.status` when `confirmOrderPayment`/`failOrderPayment` return an
outcome that actually applied (`paid`, `paid_but_unfulfillable`, `failed`,
`cancelled`) — never when they return `already_handled` (the order had
already left `pending_payment`) or `order_not_found`. This is what makes
these all safe, in any order or concurrently:

- `payment.succeeded` then `payment.failed` (or vice versa) for the same
  payment — whichever arrives first wins; the second is acknowledged
  (200) but is a no-op, and never overwrites a `paid` order's tickets or
  flips a `failed` order to `paid` retroactively.
- Two differently-IDed events for the same logical payment.
- Simultaneous `succeeded`/`failed` deliveries — the Payment row lock
  (see Atomicity below) serializes them; exactly one outcome wins.

`paid_but_unfulfillable` exists because a hold can expire (and its stock
get resold) in the window between "customer clicks pay" and "provider
confirms payment" — see `lib/orders/checkout.ts`'s checkout-expiry
extension, which shrinks but cannot eliminate this race. When it happens,
the customer's money was captured (`Payment.status = 'paid'`) but no
tickets are generated; this is intentional (never oversell) but currently
has **no automated resolution** — it needs an admin alert and/or automatic
refund once the admin dashboard and refund flow exist (tracked in
TASKS.md).

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
per Reservation:

- `ensurePendingOrderAndPayment` locks the `Reservation` row
  (`FOR UPDATE`) first, so concurrent checkout requests for the *same*
  reservation fully serialize — only the first creates an Order/Payment;
  every other one (sequential retry or concurrent race) takes the
  "already checked out" branch and returns the existing Order's
  `redirectUrl`.
- `order_items.reservation_id` carries a database `UNIQUE` constraint as
  defense in depth, independent of the application-level lock.
- The external `provider.createPayment()` call happens **outside** the
  database transaction (it's I/O, not something to hold a DB transaction
  open for) and only when no `redirectUrl` is stored yet. If it throws —
  network failure, provider outage, or `getPaymentProvider()` itself
  failing to initialize — the already-committed Order/Payment are left
  exactly as they were (`pending_payment` / `awaiting_payment`, no
  `providerPaymentId`); the customer's retry re-enters the same function,
  takes the "already checked out" branch, and safely retries **only** the
  provider call against the same Payment row. A second Order is never
  created because of a provider failure.

See `tests/integration/checkout-idempotency.test.ts` for sequential
retry, concurrent retry, and provider-failure-then-retry scenarios.

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
- Refund flow and UI.
- Automated handling of `paid_but_unfulfillable` orders.
