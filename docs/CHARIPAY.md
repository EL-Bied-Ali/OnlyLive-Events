# ChariPay integration

This document records the provider-specific facts used by PR #13. It is
intentionally narrower than `docs/PAYMENTS.md`: generic payment/order rules stay
there; ChariPay API details live here so they are not guessed from the fake
provider.

Source of truth: ChariPay's published v1 API reference (`charipay.ma/*/api-docs`),
which states that it is generated from the provider's OpenAPI contract. Do not
change endpoint/field/signature behavior from memory; re-check the official
contract first.

## Environment and credentials

- API base URL is the same in sandbox and production:
  `https://api-psp.charipay.ma`.
- The API key selects the environment: sandbox keys use the documented test
  prefix; production uses the live prefix.
- `PAYMENT_PROVIDER=charipay` requires `CHARIPAY_API_KEY` and
  `CHARIPAY_WEBHOOK_SECRET`. `instrumentation.ts` calls
  `getPaymentProvider()` at startup, so an invalid production configuration
  fails closed before serving customer traffic.
- Sandbox and production webhook endpoints/secrets are separate.
- Never commit or log API keys or webhook signing secrets.

## Hosted checkout

OnlyLive uses `POST /v1/payment-sessions`, never the direct-card endpoints.
This keeps PAN/CVV outside OnlyLive's application and browser code.

The adapter sends:

- amount in MAD major units (OnlyLive stores integer centimes internally);
- the OnlyLive Payment id as `externalId`;
- the existing Payment idempotency key as `Idempotency-Key`;
- the OnlyLive order id as the provider order reference;
- buyer email;
- HTTPS accept/decline and notification URLs;
- the OnlyLive checkout expiration as `expiresAt`;
- `singleUse: true` and `notifyOnFailure: true`;
- opaque OnlyLive reconciliation ids in `metadata`.

The response must contain `sessionId` and `checkoutUrl`; both are persisted on
the Payment. Browser return is display/navigation only. It is never accepted as
proof that money moved.

ChariPay defaults sessions to 72 hours if `expiresAt` is omitted. OnlyLive does
not use that default: the provider session expires with the checkout hold, which
reduces late-payment/unfulfillable-order risk. The existing late-payment
reconciliation path remains defense in depth.

All declared callback URLs must be public HTTPS on the default port. Local
sandbox testing therefore needs a deliberate public HTTPS preview/tunnel; the
adapter rejects HTTP/explicit-port callbacks before sending the request.

## Webhook verification and idempotency

The provider signs the exact raw request body. Verification must happen before
JSON parsing or business-state lookup.

- `X-CHARI-TIMESTAMP`: epoch milliseconds.
- `X-CHARI-SIGNATURE`: lowercase hex HMAC-SHA256 of
  `timestamp + "." + rawBody`.
- Reject timestamps outside the documented ±5-minute window.
- Compare digests with `timingSafeEqual`.
- Deduplicate on `Chari-Event-Id`, never `Chari-Webhook-Id`; delivery ids change
  across retries while the logical event id is stable.
- During secret rotation ChariPay may also send
  `X-CHARI-SIGNATURE-NEXT`; the receiver can accept either configured signing
  secret/signature during the transition.
- Delivery is at-least-once and may be out of order; duplicate processing must
  therefore remain harmless.

Only subscribe the production endpoint to event types OnlyLive handles. The
current integration needs `payment.succeeded`, `payment.failed`,
`refund.succeeded`, and `refund.failed`.

Payment events still pass the existing OnlyLive amount/currency check before
any ticket/order transition. A valid signature by itself is never enough.

### Exact JSON payload gate

The public reference documents signing, headers, event names, metadata/external
id reconciliation, and exposes the exact signed body through the delivery-log
API. It does not expose a complete example body for every event in the public
page text available to this development session.

For that reason PR #13 is **not production-ready until a real sandbox delivery
has been captured** (synthetic `payment.succeeded`, real success/failure, and
refund success/failure) and the adapter's JSON fixture/mapping has been pinned
to those exact signed bodies. Current parsing is deliberately fail-closed: a
payment event without usable reconciliation/amount data cannot generate a
ticket.

## Refund lifecycle

ChariPay refunds are asynchronous.

`POST /v1/refunds` takes the original payment `externalId`, a caller-owned
`refundReference`, reason and optional partial `refundAmount`. A fresh request
returns `202 Accepted`; final success/failure arrives by webhook. Replaying the
same `refundReference` returns the existing refund instead of debiting twice.

OnlyLive therefore uses the Refund row id as the stable refund reference and
runs refunds in two phases:

1. Under Payment/Order locks, validate refundable balance and create one durable
   Refund row in `processing`. Both `processing` and `succeeded` amounts reserve
   refundable balance, so concurrent submissions cannot over-refund.
2. Commit that row **before** external network I/O, then submit it to ChariPay.
3. Do not change Payment/Order/ticket/inventory state while the provider refund
   is merely pending.
4. On signed `refund.succeeded`, finalize idempotently: update Refund,
   Payment/Order status, cancel still-valid tickets and release sold inventory
   only when the payment becomes fully refunded, then send confirmation email.
5. On signed `refund.failed`, mark only that Refund failed and free its amount
   for a later attempt.

A provider 4xx response is a definitive rejection and the Refund is marked
failed. A network exception or 5xx has ambiguous outcome: the same Refund stays
`processing` and keeps its reference/amount reserved so a second random refund
cannot accidentally return the money twice. This ambiguous state needs provider
webhook/reconciliation rather than blind creation of another Refund row.

Refund webhook event claims keep `PaymentEvent.processedAt = null` until the
refund finalizer succeeds. If the server crashes between claim and business
update, provider retry re-enters the idempotent finalizer instead of silently
losing a money event.

## Required sandbox acceptance before merge/go-live

Before PR #13 can be considered provider-verified:

1. create a ChariPay sandbox account/key;
2. expose a deliberate HTTPS preview/tunnel for the OnlyLive webhook;
3. register an endpoint with an explicit event allowlist and save its signing
   secret securely;
4. send ChariPay's synthetic signed test event and compare the exact body with
   the fixture/parser;
5. complete one hosted checkout with the official sandbox card and 3-D Secure;
6. exercise a failed payment with `notifyOnFailure` enabled;
7. submit a full/partial refund and observe `refund.succeeded`/`failed`;
8. replay one logical webhook and one refund reference to prove provider-side
   idempotency against the database-side guarantees;
9. inspect the provider delivery/reconciliation log and capture relevant
   correlation ids without logging secrets/card data.

Production additionally requires OnlyLive's ChariPay merchant/KYB approval and
live credentials. Switching to production must not change code or endpoints;
only authorized environment secrets/configuration change.
