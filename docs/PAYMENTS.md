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
  `refund.succeeded`) with `signatureValid: boolean`.
- `refund` is schema-ready (`Refund` model) but not wired into any flow
  yet.

## Order/payment state machine

`Order.status`: `pending_payment → paid | failed | cancelled |
paid_but_unfulfillable`; `paid | paid_but_unfulfillable → refunded |
partially_refunded`. See `lib/orders/stateMachine.ts` for the full,
independently unit-tested transition table — that module is a pure
documentation/validation layer; the actual concurrency-safe enforcement is
the guarded SQL `UPDATE ... WHERE status = 'pending_payment'` in
`lib/orders/fulfillment.ts`, which is both the row lock and the guard.

`Payment.status`: `pending → awaiting_payment → paid | failed |
cancelled`; `paid → refunded | partially_refunded`.

`paid_but_unfulfillable` exists because a hold can expire (and its stock
get resold) in the window between "customer clicks pay" and "provider
confirms payment" — see lib/inventory.ts's `extendHoldForCheckout`, which
shrinks but cannot eliminate this race. When it happens, the customer's
money was captured but no tickets are generated; this is intentional
(never oversell) but currently has **no automated resolution** — it needs
an admin alert and/or automatic refund once the admin dashboard and
refund flow exist (tracked in TASKS.md).

## FakeProvider (`lib/payments/fakeProvider.ts`)

Simulates a hosted-checkout PSP without inventing a real API:

1. `createPayment` never makes an external call — it points `redirectUrl`
   at the app's own `/pay/fake/[paymentId]` page.
2. That page's "Simulate success/failure" buttons call
   `POST /api/pay/fake/[paymentId]/simulate` (customer-session-gated, a
   dev/sandbox convenience — a real PSP's webhook has no such gate).
3. That route builds the exact webhook payload a provider would send
   (`{eventId, providerPaymentId, type, amountCents}`), signs it with
   HMAC-SHA256 using `FAKE_PSP_WEBHOOK_SECRET` (a server-only secret,
   never sent to the browser), and **actually POSTs it** to the real
   `POST /api/payments/webhook/fake` route over HTTP.
4. That route is the genuine verification path: signature check
   (`crypto.timingSafeEqual`) → idempotent `payment_events` insert
   (`ON CONFLICT (provider, external_event_id) DO NOTHING`) → the
   order-row-locked transition in `lib/orders/fulfillment.ts` → ticket
   generation.

Because step 4 is real code exercised end-to-end (not stubbed), swapping
in a real PSP later means implementing steps 1–3 against that PSP's actual
API/webhook format — step 4's logic is reused unchanged.

## Idempotency and replay resistance

`payment_events.(provider, external_event_id)` is `UNIQUE`. The webhook
handler's insert is `INSERT ... ON CONFLICT DO NOTHING RETURNING id`; no
row back means "already processed" and the handler returns 200
immediately without touching order/payment state again — this is what
makes duplicate deliveries, at-least-once webhook semantics, and network
retries safe. See `tests/integration/payment-webhook.test.ts` for the
exact scenarios this covers (duplicate exact event, two different event
ids for one payment, tampered signature, late payment after hold expiry).

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
