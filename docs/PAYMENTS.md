# Payments

OnlyLive keeps provider-independent money/ticket invariants in this document.
ChariPay is the selected real PSP candidate and is being integrated from its
official v1 documentation in draft PR #13. Provider-specific request fields,
HMAC headers, refund semantics, sandbox acceptance steps and remaining go-live
gates are documented in `docs/CHARIPAY.md`.

The `FakeProvider` remains the local/CI provider. Production ChariPay traffic is
not approved until the exact signed webhook JSON has been validated against a
real sandbox delivery, the sandbox payment/refund lifecycle has been exercised,
full CI is green and an independent audit has been triaged.

## `PaymentProvider` interface

`lib/payments/provider.ts` is the only provider contract used by checkout,
webhook processing and refunds:

```ts
interface PaymentProvider {
  readonly name: string;
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
  parseWebhook(input: ParseWebhookInput): Promise<ParsedWebhookEvent>;
  refund(input: RefundInput): Promise<RefundResult>;
}
```

The normalized webhook types currently needed by the application are:

- `payment.succeeded`
- `payment.failed`
- `payment.cancelled`
- `refund.succeeded`
- `refund.failed`

A browser redirect is never proof of payment. Tickets become valid only after a
server-side provider event has passed authentication, idempotency and business
integrity checks.

`RefundResult.state` is either `succeeded` or `processing`. The fake provider
settles immediately; ChariPay returns an asynchronous pending result and final
state arrives by signed webhook.

## Provider selection and production guards

`getPaymentProvider()` supports `fake` and `charipay`.

Fake payments are refused whenever `NODE_ENV=production` unless
`ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true` is deliberately set for an isolated
non-customer environment such as Playwright's production-mode test server.
The fake pay page and fake HTTP endpoints have matching guards.

When `PAYMENT_PROVIDER=charipay`:

- `CHARIPAY_API_KEY`, `CHARIPAY_WEBHOOK_SECRET`, `CHARIPAY_ENV` and
  `ONLYLIVE_PUBLIC_URL` are mandatory;
- `CHARIPAY_ENV=sandbox` requires a `chari_sk_test_...` key and is the only
  allowed mode outside Vercel Production;
- Vercel Preview/Development therefore cannot use live credentials even though
  their Next.js build itself runs in production mode;
- Vercel Production requires `CHARIPAY_ENV=live`, a `chari_sk_live_...` key,
  `CHARIPAY_PROVIDER_VERIFIED=true`, and a 16+ character `CRON_SECRET` so the
  automated refund-reconciliation fallback cannot silently be disabled;
- `ONLYLIVE_PUBLIC_URL` is the canonical HTTPS origin for PSP return/webhook
  URLs; request Host/Origin data is never used for ChariPay callbacks;
- `instrumentation.ts` calls `getPaymentProvider()` at boot, so missing/unsafe
  provider configuration fails before customer traffic is served.

Never commit or log payment credentials or webhook secrets.

## Order/payment state machine

`Order.status` includes:

- `pending_payment`
- `paid`
- `failed`
- `cancelled`
- `paid_but_unfulfillable`
- `reconciliation_required`
- `partially_refunded`
- `refunded`

`Payment.status` includes:

- `pending`
- `awaiting_payment`
- `paid`
- `failed`
- `cancelled`
- `partially_refunded`
- `refunded`

The pure transition graph is in `lib/orders/stateMachine.ts`; concurrency-safe
money/ticket transitions are enforced by row locks and guarded database writes
in fulfillment/refund code.

Policy: `Payment.status` changes only when a real transition is applied and must
never hide evidence that money was captured. A late/conflicting failure cannot
overwrite a payment already known to be paid.

## Checkout idempotency

`lib/orders/checkout.ts::startCheckout` provides two separate guarantees.

### One Order per Reservation

The reservation row is locked with `FOR UPDATE`. The first caller creates the
Order/Payment; sequential/concurrent retries reuse them. The database unique
constraint on `order_items.reservation_id` is defense in depth.

If provider initialization has not completed and the reservation has already
expired, retry fails with `HOLD_EXPIRED`. An already-created redirect remains
reusable because the customer may already be inside the provider session.

### At most one provider initialization in flight

`payments.provider_init_at` is a durable claim. Only the caller winning the
atomic guarded update invokes `provider.createPayment`; other callers poll for
the stored provider result. A stale claim can be reclaimed after the recovery
window.

The Payment's idempotency key is created once and reused for every provider
retry. A provider/network failure never creates a second Order.

For ChariPay the provider session receives the Order expiry as `expiresAt`, so
its hosted payment session does not remain payable for the provider's longer
default lifetime after OnlyLive's checkout reservation should end.

## Payment webhook authentication and idempotency

Provider adapters authenticate raw HTTP data before business state is changed.
FakeProvider uses its test HMAC scheme. ChariPay uses the exact raw-body
HMAC/timestamp/event-id contract documented in `docs/CHARIPAY.md`.

A provider-specific route normalizes the event, then OnlyLive applies the same
business rules:

1. signature/authentication must be valid;
2. the Payment must resolve to the intended provider reference/external id;
3. the provider logical event id is claimed in `payment_events` under the
   unique `(provider, external_event_id)` constraint;
4. payment amount/currency must equal the stored Payment values before any
   ticket/order transition;
5. the Payment row serializes different logical events for the same payment;
6. fulfillment/failure runs under its existing Order/inventory locks;
7. `processedAt` is written only when the intended business transition has
   completed safely.

Deliveries are assumed to be at-least-once and potentially out of order.
Duplicate events therefore must always be harmless.

### Interrupted event reclaim

If a `PaymentEvent` exists but `processedAt` is still null, a retry is not
blindly acknowledged as a duplicate. Reprocessing is allowed only when the
incoming request is consistent with the immutable facts already claimed
(payment, event type and original signature state, plus comparable payload
facts). A collision is rejected/audited and never overwrites historical raw
payload evidence.

For ChariPay asynchronous refund events the event-claim transaction and refund
finalizer are deliberately separate, but `processedAt` remains null until the
idempotent finalizer succeeds. A process crash therefore causes provider retry
to re-enter finalization instead of losing a money event.

## Amount/currency verification

A valid provider signature does not prove the amount is correct.

Before a payment success/failure transition, the normalized provider amount and
currency are compared with the `payments` row. Mismatches are audit logged and
cannot generate tickets or mutate payment/order settlement state.

Refund webhooks already apply the same fail-closed integrity checks before any
financial mutation: exact Refund amount, explicit MAD currency, ownership of
the resolved Payment, and provider/external identifiers whenever the event
contains them. The same evidence is revalidated under Refund/Payment row locks
inside the finalizer transaction before status, ticket or inventory mutation. The exact ChariPay sandbox JSON shape still must be captured and
pinned before production; fields not guaranteed by public documentation are
never invented or defaulted into trusted financial facts.

## Late or contradictory payment success

A payment can theoretically be confirmed after the original hold has expired or
a prior failure/cancellation has already released inventory. Overselling is
never allowed just because money arrived.

### Pending order, expired/unavailable inventory

If a success arrives for `pending_payment` but the original hold can no longer
be fulfilled, the order becomes `paid_but_unfulfillable`. Payment remains
`paid`; no ticket is invented and a human must reconcile/refund.

### Success after `failed`/`cancelled`

`reconcileContradictorySuccess` tries to fulfill fresh inventory under the
normal inventory locks:

- if stock still exists, generate tickets and move the order to `paid`;
- otherwise move it to `reconciliation_required`, with Payment still `paid`.

Both outcomes are audit logged. This policy intentionally prefers visible human
reconciliation over silently dropping evidence of captured money. It remains a
conservative defense even when a provider documents such event orderings as
unlikely/impossible.

## Refunds: two-phase asynchronous-safe design

`lib/orders/refund.ts::initiateRefund` is admin/super-admin only; the Server
Action also keeps the admin CSRF protection.

A real PSP refund must not be treated as complete merely because an HTTP submit
call returned successfully. ChariPay explicitly settles refunds asynchronously,
so the generic flow is now two-phase.

### Phase 1 — reserve refundable balance

Inside a database transaction:

1. lock Payment then Order;
2. require a refundable payment status and provider reference;
3. calculate remaining refundable balance using both `processing` and
   `succeeded` Refund rows;
4. reject any amount that would over-refund;
5. validate partial/full transition policy;
6. create one durable Refund row in `processing` and an audit entry.

The transaction commits **before network I/O**. A pending refund therefore
reserves its amount so concurrent admins cannot each submit a refund whose
combined total exceeds the captured payment.

### Phase 2 — provider submission and settlement

The provider call uses the durable Refund id as its stable idempotency/reference
value.

- Immediate `succeeded` (FakeProvider): finalize directly.
- Accepted asynchronous request (ChariPay): keep `processing`; do not alter
  tickets, Payment, Order or inventory.
- Definitive provider rejection (e.g. provider 4xx): mark that Refund failed so
  its reserved amount becomes available for a later business attempt.
- Ambiguous outcome (network exception or provider 5xx): keep the Refund
  `processing` and reserved. A timeout may have happened after provider
  acceptance; creating a new random refund would risk returning money twice.

Ambiguous/stuck refunds are reconciled by the authenticated housekeeping
sweep using `GET /v1/refunds/{reference}`. `SUCCESS`/`FAILED` finalize the same
Refund; `PENDING` stays reserved. A provider `404/not_found` replays the original
intent with the **same Refund.id/refundReference**. Blind creation of another
Refund reference is prohibited. `vercel.json` schedules this endpoint daily by
default as a conservative fallback; deployments that need faster recovery may
tighten that schedule or use the existing authenticated POST.

### `refund.succeeded`

The idempotent finalizer locks Refund → Payment → Order and computes total
confirmed refunds. It then:

- marks the Refund `succeeded`;
- moves Payment/Order to `partially_refunded` or `refunded`;
- on full refund only, cancels still-valid tickets and releases their sold
  inventory;
- never cancels/re-sells already-used tickets;
- writes an audit entry and triggers the refund-confirmation email after
  commit. The current `EmailLog` claim prevents duplicate sends, but crash-safe
  exactly-once delivery is a separate known gap tracked in `TASKS.md` / PR #17.

Duplicate success deliveries do not repeat stock/ticket effects. Contradictory
terminal refund events are not resolved by delivery order alone; a failed refund
requires explicit provider reconciliation evidence before any later success can
change local money state.

### `refund.failed`

The idempotent failure finalizer changes only the Refund row/audit state. Its
amount stops reserving refundable balance, allowing a later deliberate retry.
Payment/Order/ticket/inventory state remains unchanged. A later failure can
never downgrade a Refund that is already `succeeded`.

## Provider failure classification

`ProviderRequestError` distinguishes a definitive provider rejection from an
unknown money-moving outcome.

For ChariPay HTTP responses:

- 4xx: definitive rejection;
- 5xx: ambiguous outcome because provider acceptance cannot safely be ruled
  out;
- transport/network exception: ambiguous.

This distinction matters most for refunds. Checkout creation also remains
provider-idempotent through the stable Payment idempotency key.

## Auditability

Money-state anomalies and transitions are written to `AuditLog`, including:

- payment amount/currency mismatches;
- webhook event collisions;
- contradictory payment-success reconciliation;
- refund requested/submitted/succeeded/failed;
- ambiguous refund submission outcome.

Do not log raw card data, credentials, auth tokens or webhook secrets.

## Testing

Dangerous provider-independent cases are covered by integration/E2E tests,
including inventory races, checkout idempotency, duplicate/out-of-order payment
callbacks, wrong amount/currency, late payment, refund concurrency, partial/full
refund transitions, used-ticket behavior and access control.

PR #13 additionally covers:

- ChariPay hosted-session request shape and idempotency fields;
- MAD major-unit conversion and HTTPS/expiry guards;
- raw-body HMAC verification, timestamp replay window and secret rotation;
- production sandbox/live configuration guard;
- asynchronous refund pending state without premature ticket/stock mutation;
- pending-refund balance reservation against over-refund;
- idempotent refund success/failure finalization;
- legacy FakeProvider/browser flows.

A real sandbox run is still mandatory before production because provider unit
fixtures cannot substitute for capturing the exact signed JSON emitted by the
external system. See `docs/CHARIPAY.md` and `TASKS.md`.
