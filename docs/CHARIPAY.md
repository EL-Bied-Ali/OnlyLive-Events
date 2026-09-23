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
- **Deployment note:** on Vercel, `PAYMENT_PROVIDER`, `CHARIPAY_API_KEY`, `CHARIPAY_WEBHOOK_SECRET`, and the other config this section describes are currently scoped to Preview deployments of the single designated `feat/charipay-integration` branch, not every Preview branch. A brand-new PR branch's own preview therefore has none of them and fails fast at boot (`getPaymentProvider()` now throws an explicit "PAYMENT_PROVIDER is required on Vercel" error rather than the previous confusing crash — see `lib/payments/index.ts`). This is intentional, not a bug to route around by widening scope: an arbitrary PR preview is not expected to be a ChariPay sandbox-test environment, and casually granting every Preview branch the real sandbox API key/webhook secret/admin credentials would let untrusted or in-progress branch code reach the same PSP sandbox account. Real ChariPay sandbox exercises should go through `feat/charipay-integration`'s own preview (merge into it first), not a standalone PR-branch preview. If a genuinely separate sandbox-test branch is ever needed, that's a deliberate infra decision (a second designated branch, or a general Preview-default policy) — not something to solve ad hoc while fixing an unrelated PR.

## Hosted checkout

OnlyLive uses `POST /v1/payment-sessions`, never direct card endpoints. PAN/CVV therefore stay outside OnlyLive.

For each session the adapter sends MAD major units, stable OnlyLive Payment id as `externalId`, a stable `Idempotency-Key`, order id, buyer email, HTTPS browser return callbacks (accept/decline), `singleUse:true`, `notifyOnFailure:true`, and reconciliation ids in metadata. It deliberately does **not** send `config.urls.notification`: webhook delivery uses the separately registered partner webhook endpoint.

Generic checkout passes customer name/phone data unchanged. Registration itself now requires a phone number (`lib/validation/auth.ts`'s `registerSchema`, loosely validated: plausible phone characters plus an 8–15 real-digit count) precisely because ChariPay's hosted checkout needs one — but the stricter ChariPay-specific name splitting, Moroccan/international phone normalization, and final required-field validation still live inside the ChariPay adapter itself, not in registration; FakeProvider and future providers do not inherit those ChariPay-specific requirements. A ChariPay checkout fails with `PAYMENT_CUSTOMER_DETAILS_REQUIRED` before network I/O when the provider-required customer data is missing or invalid, even though registration already required a phone value upstream.

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
- `Chari-Event-Id` and `Chari-Event-Type` are separate delivery headers and are not part of that documented HMAC input. OnlyLive therefore never lets a new/unprocessed payment event mutate financial state solely from the header label: after signature + payload-integrity checks resolve the Payment, the authenticated transaction ledger must independently confirm the same Order id, amount, MAD currency, `PAYMENT`/`IN` facts and the header-claimed outcome before fulfillment/failure can run.
- An identical already-processed event short-circuits as a duplicate without another provider lookup. A terminal opposite ledger outcome is audit-logged and acknowledged `202 reconciliationRequired` with no local financial mutation. Pending/not-found/ambiguous status or a lookup failure returns `503` so ChariPay can retry while the independent reconciler remains the fallback.
- `payment.failed` remains behind `CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED=false`, but this ledger binding already protects that path once the real shape is pinned and the gate is eventually enabled. Refund webhooks remain fully fail-closed behind their own shape gate; do **not** enable that gate until equivalent authenticated refund-status binding is added.
- `X-CHARI-TIMESTAMP` is epoch milliseconds; reject more than ±5 min skew.
- Signature input must be **exactly 64 hexadecimal characters** before `Buffer.from(..., "hex")`; malformed odd-nibble strings are rejected.
- Compare in constant time.
- Deduplicate on `Chari-Event-Id`, not a delivery-attempt id.
- Delivery is at-least-once and may be out of order.
- A correctly signed payload is still schema/integrity-validated before mutation.

**Confirmed against a real signed sandbox delivery (2026-09-17, via `GET /api/v1/partner/webhooks/events/{id}`):** a `payment.succeeded` webhook's own generated fields (`Amount`, `ExternalId`, `Reference`, `CustomData`, `GatewayOrderId`, `GatewayReferenceId`, `GatewayTrackId`, `OperationId`, `OperationStatus`, `OperationType`, `WebhookEventId`) are PascalCased — except the nested `metadata` object, which is echoed back verbatim exactly as sent in `createPayment()`'s request body. Critically, **`ExternalId`/`Reference`/`CustomData` all carry the ORDER id, not the Payment id**, despite `createPayment()` sending `externalId: input.paymentId` in its own request — ChariPay's webhook re-purposes that name for something else entirely. Payment events therefore reconcile by **`metadata.onlylivePaymentId`**, and `metadata.onlyliveOrderId` is a **required** second reconciliation invariant, not optional — `createPayment()` always sends both in the same metadata object, so `parseWebhook`'s `payloadValid` rejects a payment event missing either one, and the route separately cross-checks `onlyliveOrderId` against the stored Payment's own `orderId`; there is no `sessionId`-equivalent field on a real delivery (the route falls back to matching by `paymentExternalId` alone), and no `currency` field at all — ChariPay only ever operates in MAD for this integration, so `parseWebhook` assigns `"MAD"` as that known fact rather than parsing a field that was never there, and the route separately checks it against the stored Payment's own currency. `payment.failed` applies the identical interpretation by extrapolation — only `payment.succeeded` has itself been captured from a real delivery.

**Refund webhook field names are NOT yet confirmed against a real signed delivery — only `payment.succeeded` has been captured so far** (checklist item 5 is fully done: there is no synthetic `refund.*` test to send, per ChariPay's own `/endpoints/{id}/test` contract; real refund captures are tracked separately as items 8/9). Because of this, **`refund.succeeded`/`refund.failed` webhooks are never auto-finalized from the webhook today** — `app/api/payments/webhook/charipay/route.ts`'s `CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED` flag gates the whole refund-matching path closed, and this check runs **before** the generic `payloadValid` gate (deliberately: `payloadValid` itself depends on the unverified guessed refund fields, so checking it first would 400-reject a real refund whose actual shape differs from the guess instead of acknowledging it). The gate keys only on already-confirmed envelope facts — a recognized event type and a present event id — so every refund event, however it's shaped, is acknowledged (`202`, audit-logged as `refund.webhook_shape_unverified`) without ever reaching `finalizeRefundSuccess`/`finalizeRefundFailure` or even the refund-lookup logic below it. A real refund therefore stays `processing` pending **authenticated provider-status reconciliation** — `lib/orders/refundReconciliation.ts` independently polls ChariPay's `getRefundStatus()` API (not the webhook) and finalizes from that authenticated response — or manual attention, rather than risking a silent amount/reference mismatch from a guessed webhook shape. `parseWebhook` still extracts a best-effort guess (`metadata.onlyliveRefundId` first, then guessed PascalCase/lowercase top-level fields) for in-request diagnostics only. OnlyLive does not persist the full provider body: unverified-shape audits retain only a canonical SHA-256 fingerprint plus the top-level field count; provider-controlled field names and values are not retained. Fetch the exact signed body from ChariPay's authenticated webhook-events journal when pinning a newly observed provider shape, then flip the flag once the parser/fixture is corrected against it.

**`payment.failed` field names are similarly NOT yet confirmed against a real signed delivery — only `payment.succeeded` has been captured so far** (checklist item 7 remains open). `parseWebhook` applies the same Amount/metadata interpretation to `payment.failed` purely by extrapolation, since ChariPay's own envelope only differs by `OperationStatus`, but that has never been independently verified. A `payment.failed` event marks the order/payment failed and releases inventory, so acting on that guess is not acceptable. `app/api/payments/webhook/charipay/route.ts`'s `CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED` flag therefore gates `payment.failed` closed, running **before** the generic `payloadValid` gate for the identical reason as the refund gate. Unlike the refund gate (which dedupes by `provider.name` since a refund's own local row can be resolved before the gate runs), this gate dedupes by `externalEventId` directly — a `payment.failed` event's Payment row is deliberately never resolved from an unverified body shape, so `payment_events`'s own `(provider, externalEventId)` claim isn't available this early. A real `payment.failed` is acknowledged (`202`, audit-logged once as `charipay.payment_failed_shape_unverified` against `entityType: "PaymentProviderEvent"`) without ever reaching `failOrderPayment()`, a `Payment`/`Order` status write, inventory release, or the failure email enqueue. Flip the flag once a real `payment.failed` delivery is captured and `parseWebhook` is corrected/pinned against it — the same way `payment.succeeded` already was.

A signed synthetic endpoint test (`Test:true`) is acknowledged with no financial mutation and is recorded in AuditLog.

The `refund.provider_unknown` path below (for a signed provider refund unknown to OnlyLive, e.g. one created directly in the ChariPay portal/API) is currently **unreachable** while `CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED` is false: the shape-unverified gate above acknowledges every refund event before this logic ever runs. It will resume mattering once the flag flips. **Operational policy before go-live: do not initiate refunds in the ChariPay portal or another external client.** OnlyLive cannot yet represent those as first-class Refund rows because its model requires an OnlyLive admin initiator. Import/source-aware support is a future enhancement.

## Webhook endpoint registration gate

Register a dedicated HTTPS endpoint on port 443 with an explicit allowlist only:

- `payment.succeeded`
- `payment.failed`
- `refund.succeeded`
- `refund.failed`

Pin the webhook `apiVersion` to the provider's published payload contract version and verify the exact accepted literal in sandbox before final provider verification. Never leave `enabledEvents` null/empty, because that subscribes to all current and future events.

**Sandbox finding (2026-09-17):** sending a per-session `config.urls.notification` caused ChariPay to auto-register a second endpoint ("Session notification URL (auto-registered)") in addition to the dedicated partner endpoint. The auto-registered endpoint dropped the `x-vercel-protection-bypass` query parameter and its real deliveries returned Vercel `401 Unauthorized`. The dedicated registered endpoint retained the bypass query and it exactly matched Vercel's current automation-bypass secret. A single payment also produced duplicate webhook-event rows, one for each endpoint. Therefore OnlyLive omits the per-session notification URL and treats the registered partner endpoint as the sole webhook ingress.

**Sandbox queue finding (2026-09-18):** one older failed registered-endpoint delivery remained in `retrying` state and blocked every newer event behind it at `pending / attemptCount=0`. Calling the provider's documented endpoint `activate` action reset the failure counter and immediately retried that older item; it then reached OnlyLive and returned `200` on attempt 6. The newer already-queued rows nevertheless remained stranded at attempt 0 even after a second activate and a full `enabled=false -> enabled=true` PATCH cycle. Treat this as a provider-side delivery-queue defect: do not rely on webhook retries alone for payment recovery.

The registration secret is returned only once. Store it as a secret. **ChariPay's own documentation is internally contradictory on rotation:** the API overview states, verbatim, "During a rotation, while the old secret is still in its grace window, we send the same body signed twice," while the `rotate-secret` endpoint reference states, verbatim, "Immediately invalidates the previous secret." These cannot both be literally true, and neither has been confirmed against real provider behavior. OnlyLive's `CHARIPAY_WEBHOOK_SECRET`/`CHARIPAY_WEBHOOK_SECRET_NEXT` support **both** possibilities defensively: `verifySignature` checks both secrets against both signature headers (`X-CHARI-SIGNATURE`, `X-CHARI-SIGNATURE-NEXT`) — see `charipayWebhookRotation.test.ts` — so it degrades safely whether ChariPay sends a dual-signed grace window or cuts over immediately. Do not treat either doc claim as established provider truth; sandbox acceptance checklist item 15 below is the actual arbiter — only a real coordinated rotation test in sandbox settles which behavior (or something else entirely) ChariPay actually implements.

## Refund lifecycle

Refunds are asynchronous. `Refund.id` is the stable `refundReference` and must never be replaced by randomness on retry.

**Real sandbox identifier finding (2026-09-18):** a 5.00 MAD partial-refund attempt against a real successful 10.00 MAD sandbox payment reached `POST /v1/refunds` and was definitively rejected with HTTP `400`, provider code `MISSING_PARAMETER`, correlation id `aa45ebee-4654-4d3e-8539-b5c14bbb3e8e`. The request contained the documented required `refundReference` and `reason`, plus `refundAmount`, metadata and the same OnlyLive Payment id previously sent as the checkout session's client-supplied `externalId`. This disproves the assumption that the documented `externalId` route is sufficient in this sandbox, but it does **not** prove that the Order id should be substituted there. The public refund contract independently supports `operationId`, and the already-pinned transaction ledger exposes a unique canonical operation id after verifying Order id, original amount/currency, `PAYMENT`, `IN`, and `SUCCESS`. OnlyLive therefore resolves that exact ledger transaction first and submits refunds by `operationId`; if the lookup is missing, pending, ambiguous, truncated, malformed, rate-limited, or otherwise unverified, no refund POST is sent.

**Real sandbox `reason` finding (2026-09-22):** with the `operationId` fix above already in place and working correctly, a real partial-refund attempt still failed with the identical `400 MISSING_PARAMETER` (correlation id `9bd23512-ab87-4022-8f7b-3a19a9706850`) — a second, distinct bug. ChariPay's own error message was explicit: `reason` is a closed enum (`MERCHANT_CANCELLATION` / `CUSTOMER_CANCELLATION` / `PLATFORM_ORCHESTRATION` / `OTHER`), not free text — "Free text belongs in `note`." Confirmed against the published `POST /v1/refunds` schema at charipay.ma/fr/api-docs/refunds. OnlyLive's admin-entered free text (`RefundInput.reason`, already documented above as an internal note never shown to the customer) now maps to ChariPay's `note` field; `reason` is fixed to `"OTHER"`, the least presumptive of the four values, since the generic admin refund form has no way to know which specific category honestly applies.

**Real sandbox downstream-refund permission finding (2026-09-22, portal rechecked later the same day):** with both fixes above in place, a retried refund returned HTTP `202` (request syntax accepted) but the response *body* itself carried a synchronous business failure: `status: "FAILED"`, `providerRefundId: null`, `failureCode: "BAAS_CHARI_ERROR"`, `failureMessage: "[REFUND_MERCHANT_CARD_PAYMENT] Chari API error (HTTP 403): 403 Forbidden ... Access denied. Missing required scopes: operations:refund"` (correlation id `46965bf5-7d91-4655-9e71-7d909e5a11b0`). This is **not a code bug**. The active merchant key already has the two refund permissions exposed by the ChariPay portal, `refund:create` and `refund:read`. The portal's complete editable permission list does **not** expose any `operations:refund` scope, so this cannot be fixed by editing/regenerating the key from self-service settings. The failure is downstream inside Chari/ChariPay and must be escalated to ChariPay support for sandbox enablement or the provider-supported procedure. `refundId`/`refundReference` are `null` on this failure — nothing was created provider-side to reconcile. Support should be given the correlation id above and the exact provider error. The code-side gap this exposed has been fixed regardless: a 2xx HTTP response whose body reports a synchronous `failureCode`/`failureMessage` was previously discarded entirely (the thrown error said only `status: "FAILED"`, no indication of why) — both fields are now safely surfaced (bounded code, sandbox-only redacted message) the same way the `!response.ok` path already handles `MISSING_PARAMETER`.

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

## Payment reconciliation after lost webhooks

ChariPay recommends reconciling with `GET /v1/transactions` after a longer outage rather than waiting for an exhausted webhook delivery to return. This fallback is now implemented in the expired-checkout reconciler before any session cancellation or inventory release.

A real sandbox `PAYMENT / SUCCESS` transaction captured on 2026-09-18 pinned the response shape:

- list envelope: `{ data, hasMore, nextCursor }`;
- transaction fields used by OnlyLive: `operationId`, `type`, `status`, `amount`, `currency`, `direction`, `externalReference`;
- `externalReference` is exactly the OnlyLive **Order id**; searching by the OnlyLive Payment id returned no match;
- the observed successful transaction was `type=PAYMENT`, `direction=IN`, `status=SUCCESS`, exact MAD amount/currency.

Automatic recovery is deliberately fail-closed. OnlyLive searches by Order id and accepts success only when there is exactly one exact `externalReference` match, the search result is not truncated, `type=PAYMENT`, `direction=IN`, amount converts exactly to the stored integer cents, currency is exactly the stored `MAD`, and status is exactly `SUCCESS`. `PENDING`/`PENDING_3DS`, multiple matches, truncated results, malformed responses, unknown statuses, or any immutable-field mismatch keep inventory reserved. `FAILED`/`CANCELED`/`not_found` still do **not** release inventory by themselves; OnlyLive continues to require the existing explicit payment-session close/non-payable proof before cancellation.

A recovered success is finalized through the same `confirmOrderPayment` transaction as a webhook: Payment becomes paid, tickets/inventory are updated atomically, the correct durable email outbox row is enqueued, and an audit record stores only safe provider evidence. A later signed webhook remains idempotent.

## Cash gate

ChariPay's hosted checkout explicitly offers card **or cash at an agency**. The Payment Session request schema does not expose a per-session method selector in the current public contract. Before production, verify in the merchant account/support that CASH can be disabled for OnlyLive hosted checkout. A roughly ten-minute ticket checkout hold is not compatible with a customer travelling to an agency; do not invent a cash flow in this PR.

## Required sandbox acceptance before provider verification

Before setting `CHARIPAY_PROVIDER_VERIFIED=true`:

1. create/use the sandbox API key with least-privilege runtime permissions;
2. deploy a deliberate public HTTPS OnlyLive preview with its own non-production database;
3. register the webhook endpoint with explicit allowlist and pinned `apiVersion`;
4. store the signing secret outside Git;
5. send the real synthetic signed test event, then fetch its delivery record/body from the ChariPay event log; **done** — ChariPay's synthetic-test endpoint only ever queues a `payment.succeeded` carrying `Test: true` (there is no synthetic `refund.*` equivalent to send), and this was captured 2026-09-17 via `GET /api/v1/partner/webhooks/events/{id}` (see "Webhook verification" above). Real (non-synthetic) `payment.failed` and refund captures are tracked separately as items 7/8/9;
6. complete real sandbox hosted checkout + 3-D Secure success; **done, end-to-end** — sandbox only accepts one documented test card (`4918914107195005`, CVV `123`, 3DS code `555`; other cards, including `4242...`-style ones, are rejected upstream even though the hosted UI still reaches an ACS page). A real signed `payment.succeeded` webhook was captured, the parser fixed against its actual body, and the exact stuck delivery replayed against the fixed code: `200`, order confirmed, ticket generated, confirmation email sent (2026-09-17). `payment.failed` and refund success/failure remain unverified — see items 7/8;
7. exercise a real payment failure; **in progress** — `payment.failed` is now explicitly fail-closed (`CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED = false`, mirroring the refund gate — see "Webhook verification" above) pending one real signed sandbox capture. Once captured, pin the exact fixture, correct `parseWebhook()` against it, add fixture tests analogous to `payment.succeeded`'s, then flip the flag;
8. exercise full and partial refund success/failure; **blocked on provider-side sandbox enablement, not the integration or an editable key permission** — two real code-side bugs found and fixed via real sandbox attempts (2026-09-18 `operationId` vs `externalId`; 2026-09-22 `reason` closed-enum vs free text — see "Refund lifecycle" above for both), but the next real attempt (2026-09-22, correlation id `46965bf5-7d91-4655-9e71-7d909e5a11b0`) returned HTTP 202 with a synchronous body-level failure: `failureCode: "BAAS_CHARI_ERROR"`, "Access denied. Missing required scopes: operations:refund". The active sandbox key already has the portal-exposed `refund:create` and `refund:read` permissions, and the portal does not offer any `operations:refund` permission to select. Do not rotate or broaden the key speculatively. Escalate this exact error/correlation id to ChariPay support and ask them to enable the downstream refund operation or provide the supported sandbox procedure. Item remains open until a real refund is accepted/finalized with its webhook/status payload pinned;
9. replay a webhook delivery and the same `refundReference`;
10. **done** — real sandbox evidence showed that `config.urls.notification` auto-registers a duplicate endpoint, drops the Vercel bypass query, and duplicates event delivery; OnlyLive now omits the per-session notification URL and relies only on the registered partner webhook endpoint;
11. verify real rate-limit/`Retry-After` headers and correlation ids;
12. confirm CASH is disabled or explicitly redesign the hold flow;
13. **done** — real sandbox transaction responses and Order-id search behavior are pinned; strict authenticated transaction-ledger recovery is implemented before checkout cancellation;
14. capture Payment Session lookup/cancel responses and exact status values needed to release an expired checkout safely;
15. verify the provider's actual secret-rotation behavior and perform one coordinated rotation test;
16. replace/pin test fixtures to the exact signed provider bodies observed; **done for `payment.succeeded`** (`tests/integration/charipay-webhook.test.ts`, `tests/unit/payments/charipayProvider.test.ts`), still open for `refund.*`;
17. configure a commercial reconciliation cadence materially faster than the current daily Hobby cron without exceeding the measured provider budget.

Production also requires ChariPay KYB/live enablement. No code path may enable live credentials outside Vercel Production.