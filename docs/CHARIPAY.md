# ChariPay integration

Provider-specific source of truth for PR #13. Generic order/payment invariants live in `docs/PAYMENTS.md`.

The public reference is generated from ChariPay's OpenAPI contract. Re-check that contract before changing endpoint names, fields, signatures, status handling, or retry semantics.

## Environment and credentials

- API base URL: `https://api-psp.charipay.ma` in sandbox and production.
- Test key prefix: `chari_sk_test_`; live: `chari_sk_live_`.
- OnlyLive additionally requires `CHARIPAY_ENV=sandbox|live` and checks that it matches the key prefix.
- Vercel Preview/Development and non-Vercel runtimes permit sandbox only.
- Vercel Production requires `CHARIPAY_ENV=live`, `CHARIPAY_PROVIDER_VERIFIED=true`, a canonical `ONLYLIVE_PUBLIC_URL`, webhook secret, and a 16+ char `CRON_SECRET`.
- Never log API keys or webhook secrets.
- Historical Payment rows are routed by their persisted `Payment.provider`; `PAYMENT_PROVIDER` selects only the provider for newly-created payments.
- Preview/staging and Production must use separate databases. `Payment.provider=charipay` does not encode sandbox vs live; environment separation is therefore an infrastructure invariant, not something a historical Payment row can reconstruct later.

## Hosted checkout

OnlyLive uses `POST /v1/payment-sessions`, never direct card endpoints. PAN/CVV therefore stay outside OnlyLive.

For each session the adapter sends MAD major units, stable OnlyLive Payment id as `externalId`, a stable `Idempotency-Key`, order id, buyer email, HTTPS callbacks, `singleUse:true`, `notifyOnFailure:true`, and reconciliation ids in metadata.

Generic checkout passes optional customer name/phone data unchanged. ChariPay-specific name splitting, Moroccan/international phone normalization, and required-field validation live inside the ChariPay adapter; FakeProvider and future providers do not inherit ChariPay customer requirements. Registration therefore keeps phone optional, while a ChariPay checkout fails with `PAYMENT_CUSTOMER_DETAILS_REQUIRED` before network I/O when the provider-required customer data is missing or invalid.

`Idempotency-Key` protects network retries and `externalId` protects business re-issue. Both must remain stable for one OnlyLive Payment.

ChariPay must return `sessionId` and an HTTPS `checkoutUrl`. A malformed successful response is treated as an unknown provider outcome, never as proof that no session exists.

### Expiry invariant

Provider checkout expires 60 seconds before the local Order/Reservation deadline. More importantly, an order-linked reservation is **never released only because the local clock passed its deadline**. Once checkout started, payment may be in flight; inventory remains reserved until provider state is explicitly reconciled.

After local expiry:

- a provider redirect is never blindly reused;
- a new provider session is not started;
- OnlyLive returns `CHECKOUT_RECONCILIATION_REQUIRED` when a provider session already exists;
- pre-checkout holds (`orderId IS NULL`) still expire/release normally.

The reconciler calls the documented `POST /v1/payment-sessions/{sessionId}/cancel` endpoint. ChariPay documents a successful cancel as expiring the session so it can no longer be paid; that definitive success allows local cancellation/release. The explicit `410 SESSION_EXPIRED` state is also treated as non-payable. Ambiguous `404`/`409`, transport failures, unknown codes and malformed provider responses remain fail-closed: inventory stays reserved and the order is surfaced for attention. Sandbox must still pin the exact observed response/status bodies before provider verification.

Browser return is display/navigation only, never proof of payment. The customer order page refreshes boundedly while payment/reconciliation is non-terminal.

## Webhook verification

- Signature: HMAC-SHA256 over `timestamp + "." + rawBody`.
- `X-CHARI-TIMESTAMP` is epoch milliseconds; reject more than ±5 min skew.
- Signature input must be **exactly 64 hexadecimal characters** before `Buffer.from(..., "hex")`; malformed odd-nibble strings are rejected.
- Compare in constant time.
- Deduplicate on `Chari-Event-Id`, not a delivery-attempt id.
- Delivery is at-least-once and may be out of order.
- A correctly signed payload is still schema/integrity-validated before mutation.

Payment events reconcile by OnlyLive `externalId` and, when supplied, provider `sessionId`. A missing optional session id does not force a mismatch.

Refund events must match stored refund amount, MAD currency, Payment and any provider/external identifiers supplied. Evidence is rechecked under DB locks in the finalizer transaction.

A signed synthetic endpoint test (`Test:true`) is acknowledged with no financial mutation and is recorded in AuditLog.

A signed provider refund unknown to OnlyLive (for example a portal/API refund created outside OnlyLive) is captured durably as `refund.provider_unknown` and acknowledged `202` instead of being retried forever. **Operational policy before go-live: do not initiate refunds in the ChariPay portal or another external client.** OnlyLive cannot yet represent those as first-class Refund rows because its model requires an OnlyLive admin initiator. Import/source-aware support is a future enhancement.

## Webhook endpoint registration gate

Register a dedicated HTTPS endpoint on port 443 with an explicit allowlist only:

- `payment.succeeded`
- `payment.failed`
- `refund.succeeded`
- `refund.failed`

Pin the webhook `apiVersion` to the provider's published payload contract version (the public API reference is currently v1.0.0) and verify the exact accepted literal in sandbox before final provider verification. Never leave `enabledEvents` null/empty, because that subscribes to all current and future events.

The registration secret is returned only once. Store it as a secret. The current public endpoint contract says `rotate-secret` **immediately invalidates the previous secret** and returns the replacement once, so rotation must be coordinated atomically. OnlyLive can also accept an optional `CHARIPAY_WEBHOOK_SECRET_NEXT`/`X-CHARI-SIGNATURE-NEXT` path defensively, but production must not assume a dual-signature grace period unless sandbox/provider evidence confirms one.

## Refund lifecycle

Refunds are asynchronous. `Refund.id` is the stable `refundReference` and must never be replaced by randomness on retry.

1. Under Payment/Order locks, reserve refundable balance by inserting `Refund(status=processing)`.
2. Commit before external network I/O.
3. Submit with the same stable reference.
4. `processing + succeeded` both reserve the balance.
5. Signed success finalizes Payment/Order/tickets/inventory idempotently.
6. Signed/provider-reconciled failure marks only the Refund failed and makes that amount available again.

Conservative response classification:

- network/timeout, 408, 409, 429, 5xx => unknown / remain `processing`;
- any 409 remains ambiguous for the refund POST, including `IDEMPOTENCY_CONFLICT`; reconcile the same reference rather than freeing balance;
- malformed/empty/non-JSON/incomplete 2xx => unknown / remain `processing`;
- only a clearly definitive non-409 provider rejection may transition the local Refund to `failed`.

Provider HTTP calls have a bounded timeout. `Retry-After` and response correlation/request ids are captured for safe diagnostics/backoff without logging secrets.

### Refund reconciliation

Housekeeping uses a fair claimed reconciler:

- each due row is claimed immediately before its provider work with `FOR UPDATE SKIP LOCKED`;
- a short claim age/lease keeps concurrent workers from processing the same row while the bounded provider request is in flight;
- pending rows rotate via `updated_at`, preventing an old pending batch from starving newer refunds;
- provider `Retry-After` defers the row;
- lookup `SUCCESS`/`FAILED` finalizes locally;
- `PENDING` remains reserved;
- `not_found` replays **the same** Refund id/reference.

The repository's Vercel cron currently runs housekeeping once daily, matching Hobby-plan constraints. Webhooks remain the primary mechanism. A commercial go-live requires a materially faster reconciliation schedule (or equivalent external scheduler) after measuring ChariPay's real rate-limit/Retry-After behavior; the daily Hobby fallback alone is not an acceptable recovery window for ticket inventory or stuck refunds.

A full refund in `processing` also blocks any **new** ticket scan for that order. Used tickets stay used, but once a full refund is durably committed a still-valid ticket cannot be admitted until the refund fails or resolves. Scanner/refund paths serialize through the Order lock.

Failed async refunds are included in the admin attention metric, and the admin refundable balance subtracts both `processing` and `succeeded` refunds.

A refund already finalized `failed` is terminal locally. A later contradictory success event is intentionally not applied automatically; it remains a provider-reconciliation anomaly and the failed refund keeps the order visible for admin attention until a supported/manual reconciliation policy resolves it.

## Payment reconciliation after lost webhooks — sandbox gate

ChariPay recommends reconciling with `GET /v1/transactions` after a longer outage rather than waiting for an exhausted webhook delivery to return. OnlyLive does **not** yet auto-finalize a payment from that API because the public page available during implementation does not expose enough response-object detail to write a money-moving parser without guessing.

Before implementing this fallback, capture the real sandbox response/fixture. Any automatic payment recovery must require all of:

- transaction type exactly `PAYMENT`;
- status exactly `SUCCESS`;
- unambiguous match to the OnlyLive Payment externalId;
- exact stored amount;
- currency exactly MAD;
- no multiple conflicting candidates.

Anything else creates AuditLog/admin attention and issues no ticket. Until this gate is closed, checkout-linked expired stock stays reserved rather than being blindly resold.

## Cash gate

ChariPay's hosted checkout explicitly offers card **or cash at an agency**. The Payment Session request schema does not expose a per-session method selector in the current public contract. Before production, verify in the merchant account/support that CASH can be disabled for OnlyLive hosted checkout. A roughly ten-minute ticket checkout hold is not compatible with a customer travelling to an agency; do not invent a cash flow in this PR.

## Required sandbox acceptance before provider verification

Before setting `CHARIPAY_PROVIDER_VERIFIED=true`:

1. create/use the sandbox API key with least-privilege runtime permissions;
2. deploy a deliberate public HTTPS OnlyLive preview with its own non-production database;
3. register the webhook endpoint with explicit allowlist and pinned `apiVersion`;
4. store the signing secret outside Git;
5. send the real synthetic signed test event, then fetch its delivery record/body from the ChariPay event log;
6. complete real sandbox hosted checkout + 3-D Secure success;
7. exercise a real payment failure;
8. exercise full and partial refund success/failure;
9. replay a webhook delivery and the same `refundReference`;
10. compare per-session notification URL behavior with the registered endpoint and ensure duplicate paths are harmless or remove the redundant path;
11. verify real rate-limit/`Retry-After` headers and correlation ids;
12. confirm CASH is disabled or explicitly redesign the hold flow;
13. capture `GET /v1/transactions` responses needed for payment-loss reconciliation;
14. capture Payment Session lookup/cancel responses and exact status values needed to release an expired checkout safely;
15. verify the provider's actual secret-rotation behavior and perform one coordinated rotation test;
16. replace/pin test fixtures to the exact signed provider bodies observed;
17. configure a commercial reconciliation cadence materially faster than the current daily Hobby cron without exceeding the measured provider budget.

Production also requires ChariPay KYB/live enablement. No code path may enable live credentials outside Vercel Production.