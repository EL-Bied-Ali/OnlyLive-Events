# Tasks

Recover project state at the start of a session by reading this file,
`CLAUDE.md`, `docs/*.md`, `tests.json`, and recent git history — not from
memory alone.

## Completed (this session)

- Project scaffold: Next.js 16 / React 19 / TypeScript, ESLint, Vitest,
  Playwright, `.env.example`.
- Full Prisma schema for the core domain model (User, AdminUser, Event,
  Venue, TicketCategory, SalesPhase, Inventory, Reservation, Order,
  OrderItem, Payment, PaymentEvent, Ticket, TicketScan, Refund, AuditLog),
  with the oversell-prevention CHECK constraints as defense in depth.
- Dual-track auth foundation: customer (Auth.js v4, Credentials, JWT
  sessions — see docs/ARCHITECTURE.md for why not database sessions) and
  admin/scanner (custom AdminSession mechanism, `requireAdminRole()`).
- Inventory hold mechanism (`lib/inventory.ts`): row-locked
  `createHold`/`releaseHold`/`extendHoldForCheckout`/`sweepExpiredHolds`.
- `PaymentProvider` abstraction + `FakeProvider` sandbox implementation.
- Order fulfillment (`lib/orders/fulfillment.ts`): webhook-triggered,
  order-row-locked ticket generation, with the `paid_but_unfulfillable`
  path for late payments on expired holds.
- Basic customer flow: event listing/detail, register/login, hold →
  checkout → fake pay → order → ticket page with QR.
- Seed script: the real Tiakola (Casablanca, 05 Dec 2026) event with
  VVIP/VIP/Gradins categories and Early Bird/Phase 1 sales phases, plus an
  optional environment-gated `super_admin` AdminUser.
- Test suite: Vitest unit/integration tests + Playwright e2e tests, all
  passing in CI. See `tests.json` for the mandated-scenario checklist.
- Docs: this file, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
  `docs/PAYMENTS.md`, `CLAUDE.md`.

## Completed (payment-integrity audit fix session — branch fix/payment-integrity-audit-1)

An independent audit found 10 P1 correctness/integrity issues in the
first session's payment/checkout/inventory code. All 10 were verified
against the actual code (none dismissed) and fixed:

1. **Webhook atomicity** — claiming a `payment_events` row and applying
   it (fulfillment + `Payment.status` + `processedAt`) now run in one
   database transaction, so a crash between them can no longer leave a
   "claimed but never processed" event that a retry silently skips. A
   `payment_events` row found with `processedAt = null` is reprocessed,
   never acknowledged as a duplicate.
2. **Payment/Order status divergence** — `Payment.status` is now only
   written when `confirmOrderPayment`/`failOrderPayment` return a real
   transition, never on `already_handled`; a `paid` order's `Payment` can
   no longer be overwritten to `failed` by a late/conflicting event.
3. **Amount/currency verification** — the webhook now rejects (409,
   audit-logged) a validly-signed event whose amount/currency don't match
   the `Payment` row; `ParsedWebhookEvent` carries `currency`.
4. **Checkout idempotency** — `startCheckout` now guarantees at most one
   Order per Reservation (row lock + a database `UNIQUE` constraint on
   `OrderItem.reservationId`), returns the existing order/redirect on
   retry, and recovers cleanly from a `provider.createPayment` failure
   without creating a duplicate order/charge.
5. **Hold cancellation after checkout** — `releaseHold` now refuses
   (409) to cancel a reservation once its checkout has started.
6. **Fake provider in production** — blocked at server boot
   (`instrumentation.ts`) and at every fake-payment route/page unless
   `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true` is explicitly set.
7. **Hardcoded seed admin password** — removed; `prisma/seed.ts` now
   requires `ADMIN_SEED_EMAIL`/`ADMIN_SEED_PASSWORD` from the
   environment (validated, never printed) and skips admin creation
   entirely if unset. See docs/SECURITY.md for bootstrap/rotation.
8. **Sales eligibility** — `createHold` now atomically enforces event
   status/window, category active, phase active/window/quantity-limit,
   and an event-configured per-user purchase cap. A user/event advisory
   lock makes that cap atomic across categories; no eligibility decision
   is trusted from a pre-transaction read.
9. **Reproducible install/build** — `postinstall: prisma generate`
   added; `prisma.config.ts` no longer requires `DATABASE_URL` for
   `prisma generate`.
10. **CI** — `.github/workflows/ci.yml`: install, generate, typecheck,
    lint, migrate, unit+integration tests, build.

Regression tests added (all passing): checkout idempotency (sequential,
concurrent, provider-failure-then-retry), webhook interrupted-then-
retried, succeeded/failed in every order including simultaneous, wrong
amount/currency, hold cancellation after checkout, fake endpoints
disabled in production, and the full eligibility matrix (draft/
cancelled/sold-out/closed event, sales window, inactive category, phase
quantity limit under concurrency, purchase-limit bypass via separate
holds and across categories).

## Completed (second payment-integrity audit — same branch)

A second, independent audit reviewed the fixes above and found 5 further
P1 issues plus one non-issue. All verified against actual code (none
dismissed without evidence) and fixed:

1. **Success-after-failure was silently dropped** — a validly-signed
   `payment.succeeded` arriving after the order was already
   `failed`/`cancelled` was treated as `already_handled`, leaving a
   captured payment stranded on a dead order forever. Added
   `reconcileContradictorySuccess` (`lib/orders/fulfillment.ts`): attempts
   atomic re-fulfillment from current stock, landing on `paid` if possible
   or `reconciliation_required` if not. `Payment.status` is set to `paid`
   either way — captured money is never hidden.
2. **Concurrent provider initialization** — `startCheckout` now uses a
   durable `payments.provider_init_at` claim so concurrent callers invoke
   `provider.createPayment` only once. A stale claim can be reclaimed and
   the stable idempotency key survives retries.
3. **Expired retry after provider failure** — a retry cannot start a new
   provider payment after the reservation expires, even if the sweep has
   not run yet; an already-stored redirect remains reusable.
4. **Expired holds inflated the purchase-limit count** — expired active
   reservations are excluded directly from the purchase-cap query.
5. **Webhook reclaim consistency** — interrupted webhook claims are
   reprocessed only when payment, event type and prior signature state are
   consistent; collisions are rejected and audited.
6. **Accidental `Hello-html` doc links** — checked; none exist in this
   repository. Rejected as not applicable.

## Completed (admin dashboard foundation — PR #2)

- Protected, read-only `/admin` overview with revenue, ticket, check-in and
  pending-payment metrics plus reconciliation alerts.
- Separate admin/support authorization; customer and scanner accounts
  cannot enter the back office.
- Admin authentication/access boundaries covered in Playwright.

## Completed (atomic QR scanner — PR #3)

- Authenticated mobile-first `/scanner` with camera QR decoding and manual
  fallback.
- Atomic `VALID` / `ALREADY_USED` / `INVALID` / `CANCELLED` /
  `WRONG_EVENT` decisions; concurrent scanners cannot double-admit.
- Scanner-only authorization, network-only service worker and SHA-256 scan
  digests instead of raw QR bearer tokens.

## Completed (admin catalogue management)

- Authenticated event/venue/category/sales-phase management.
- Only `admin`/`super_admin` mutate; `support` is read-only.
- Morocco wall-clock inputs use IANA `Africa/Casablanca` conversion.
- Catalogue edits and purchases coordinate through advisory locks; capacity
  and phase limits cannot be reduced below committed quantities, active
  windows cannot overlap, and unsafe event cancellation is blocked.
- Successful mutations and their AuditLog rows commit atomically.

## Completed (admin CSV export + audit-log views)

- Cursor-paginated/filterable `/admin/audit` with best-effort actor names.
- `/api/admin/orders/export` protects against spreadsheet formula injection,
  uses RFC4180 quoting and UTF-8 BOM, and respects order-status filtering.
- Read-only access is shared by admin/super_admin/support; scanner/customer
  sessions are rejected.

## Completed (admin refund flow)

- Full/partial refunds through `PaymentProvider.refund`, restricted to
  admin/super_admin and validated against remaining refundable balance.
- Full refunds cancel still-valid tickets and release their sold stock;
  used tickets are never resold.
- Payment/Order locking serializes concurrent refund attempts.
- Provider failures are recorded/audited without blocking a later retry.
- `/admin/orders/[orderId]` exposes payment/refund/ticket history.

## Completed (transactional email — superseded by the durable outbox below)

- Swappable email-provider interface with a console-only sandbox provider.
- Original design: idempotent order-confirmation/payment-failure/refund-
  confirmation triggers using `EmailLog` uniqueness, sent after the
  business transaction committed. An independent audit found this could
  silently lose a notification forever (a crash or a thrown error between
  commit and send left no record an email was ever owed) — replaced by the
  durable outbox described next.

## Completed (durable email outbox — branch fix/email-outbox-durable)

A production-safe outbox foundation for transactional email — **not** a
real email provider integration, which remains selected-provider work in
`Next` below.

- `EmailOutbox` replaces `EmailLog`: the same `(type, entityType,
  entityId)` idempotency key, plus `status`
  (`pending`/`processing`/`sent`/`failed`), `attemptCount`,
  `nextAttemptAt`, `processingStartedAt` and `lastErrorCode`.
- The webhook handler and `initiateRefund` now `enqueue*` a row inside the
  **same** database transaction as the payment/refund state change itself
  (`app/api/payments/webhook/fake/route.ts`, `lib/orders/refund.ts`) —
  closing the commit-then-crash gap: once the business fact commits, the
  obligation to notify is durably recorded with it, never sent from a
  post-commit code path that could fail to run.
- `lib/email/dispatcher.ts` — a separate, out-of-band dispatcher
  (`dispatchPendingEmails`, invoked by the internal
  `/api/internal/dispatch-emails` endpoint on the same auth pattern as
  `sweep-expired-holds`, meant to run on a schedule):
  - Atomically claims a batch with `SELECT ... FOR UPDATE SKIP LOCKED` so
    overlapping/concurrent invocations never double-send.
  - Reclaims a row stuck in `processing` past a lease timeout (a crashed
    worker never finished it) instead of leaving it stuck forever.
  - Re-validates business state fresh at send time rather than trusting
    the enqueue-time snapshot — a row is not sent (and marked `failed`
    with `entity_state_no_longer_valid`) if the order/refund has since
    moved to a state the enqueued email no longer describes (e.g. a paid
    order that was fully refunded before its confirmation email went out).
  - Bounded exponential backoff with jitter on transient provider failure,
    up to 8 attempts before a row is marked permanently `failed`.
  - Passes the outbox row's own id as the provider's `idempotencyKey`, so
    a retried send can never double-send at the provider's own layer once
    a real provider is integrated.
  - Never logs a raw recipient address (a truncated SHA-256 hash only) or
    a full error object (a bounded message only); the refund
    confirmation email omits the admin-entered internal `reason` text.
- `lib/appUrl.ts` centralizes absolute-URL construction for email content
  (ticket links), requiring HTTPS in production; the Playwright/CI
  `next start` loopback exception now requires an explicit E2E-only opt-in.
- `isConsoleEmailAllowed()` mirrors the existing fake-payments guard:
  the console provider is refused in production unless
  `ALLOW_CONSOLE_EMAIL_IN_PRODUCTION=true` is explicitly set; validated at
  server boot (`instrumentation.ts`).

## Completed (email outbox audit fixes — same branch)

An independent audit (GPT) at `2ec4dd4` found two functional defects in the
outbox foundation above and several non-blocking go-live gates. Both
defects fixed, verified against actual code (none dismissed):

1. **HIGH — a partial refund permanently discarded the queued order
   confirmation.** `renderOrderConfirmation()` only accepted `order.status
   === "paid"`, but `lib/orders/refund.ts` moves a partially refunded
   order to `partially_refunded` while only a *full* refund cancels
   tickets. A partial refund landing before the dispatcher ran would mark
   the still-valid confirmation `failed`/`entity_state_no_longer_valid`
   and the customer would never receive it. Fixed: `partially_refunded` is
   now accepted alongside `paid`; `refunded` (and everything else) still
   is not. New test: a partial refund before dispatch still gets both the
   order and refund confirmation sent, each exactly once.
2. **MEDIUM — a single row's rendering exception poisoned the whole
   claimed batch.** `dispatchPendingEmails()` called `renderEmail(row)`
   *before* the per-row `try/catch`, so a transient DB error or a
   misconfigured `absoluteAppUrl()` while rendering one row threw out of
   the loop entirely, stranding every other already-claimed row in
   `processing` until the 5-minute lease timeout. Fixed: rendering now
   runs inside the same per-row try/catch as the provider send, so a
   render exception is retried on its own like a send failure and never
   blocks the rest of the batch. New test: one row's simulated render
   failure doesn't stop a second row in the same batch from sending.
3. Also corrected `renderPaymentFailed()`'s wording, which asserted
   `"Aucun montant n'a été débité"` (no amount was debited) — a fact this
   provider-neutral foundation cannot universally guarantee once a real
   PSP is behind it. Now matches the safer wording already established
   during the ChariPay integration audit: payment not confirmed, don't
   pay again if a debit appears until it's verified.

Tracked as pre-real-provider/deployment gates, not fixed here (agreed
non-blocking while only the instant `ConsoleEmailProvider` exists):
claiming releases the row before `send()` completes, so a real provider
call exceeding the 5-minute lease could let a second worker reclaim and
double-send, and a stale worker could then overwrite the second worker's
result — needs a request timeout shorter than the lease plus a fencing/
conditional-finalization mechanism before a real provider is wired in.
`errorCode()`'s stored/logged error message was not guaranteed free of
provider-specific sensitive data; this is now closed by the privacy-safe
provider/error-code hardening documented below. `/api/internal/
dispatch-emails` now accepts `CRON_SECRET`/`Authorization: Bearer` the
same way `/api/internal/sweep-expired-holds` does (`lib/http/
internalAuth.ts`, shared by both routes; fixed during the PR #13 merge
audit), but it is still **not** in `vercel.json`'s `crons` array: the
current Vercel Hobby plan only allows a cron to run once per day, far too
infrequent for customer-facing order-confirmation/failure emails. An
external higher-frequency scheduler (or a paid Vercel plan, once
budgeted) must call this route directly — not provisioned yet, so
dispatch cannot be relied on to run promptly until it is. The previous
hostname-only HTTP-loopback exemption in `lib/appUrl.ts` is now closed by
the explicit E2E-only production opt-in documented below.

A second independent audit (GPT) flagged the `email_outbox` migration's
`DROP TABLE "email_logs"` as an irreversible loss of historical send
records rather than a routine follow-up, and asked that this be verified
rather than assumed. Confirmed: `ConsoleEmailProvider`
(`lib/email/fakeProvider.ts`) is the only `EmailProvider` implementation
that has ever existed in this codebase (`lib/email/index.ts`'s factory has
no other case) — `email_logs` could only ever have been populated by
local dev/test/e2e runs against that sandbox, never a real customer
communication, and no environment with a working database existed before
today's build fix (see the lazy-Prisma-client fix above). There is
nothing meaningful in that table to migrate. If a real `EmailProvider` is
ever added retroactively to a version of this app that already has actual
`email_logs` history, that data would need to be migrated forward before
running this migration — not a concern for the app's current state.

## Completed (auth rate limiting — PR #8)

- Atomic Postgres fixed-window limiter shared across serverless instances.
- Independent HMAC-pseudonymized per-IP and per-account/email buckets;
  successful login does not consume the failed-attempt account budget.
- Vercel IP preference, IP validation/canonicalization, conservative
  unknown bucket and 48-hour retention pruning.
- Production fails closed on missing/weak limiter secret or an unsafe
  disable flag.

## Completed (CSP + admin/scanner CSRF hardening — PR #9)

- Global CSP/browser security headers with a documented static-rendering
  compatibility trade-off rather than nonce-forcing every page dynamic.
- Session-bound HMAC synchronizer token for custom admin/scanner mutations;
  raw httpOnly session tokens never reach client JavaScript.
- Admin login applies source-origin checks before credential work; logout
  and scanner mutations require source-origin + session token.
- Catalogue/refund Server Actions require the same session-bound token in
  addition to Next.js Origin/Host validation and server-side role checks.
- Vercel forwarded host/protocol behavior has unit regression coverage;
  real preview/custom-domain smoke testing remains a pre-production task.

## Completed (isolated Playwright database — PR #10)

- Playwright now requires a dedicated `E2E_DATABASE_URL`; both direct
  Prisma imports in specs and the spawned Next.js server are pinned to it.
- `npm run test:e2e` resets/migrates/seeds only that E2E database before
  the browser suite. The destructive guard accepts PostgreSQL only,
  requires an explicit `e2e` name segment, requires localhost/loopback,
  rejects query-string/fragment ambiguity, and refuses the configured
  dev/Vitest databases.
- The same safety gate runs from `playwright.config.ts`, so direct
  `npx playwright test` cannot silently bypass the database validation.
  Playwright config reloads preserve the original source database solely
  for collision checking while the runtime stays pinned to E2E.
- Browser tests always start their own server on `http://localhost:3100`
  (or the explicitly configured test port), never reuse a developer's
  existing Next.js process and cannot target an arbitrary external base URL.
- CI now uses three distinct logical databases on its disposable Postgres
  service: app/build, Vitest and Playwright. The PostgreSQL healthcheck also
  targets `onlylive_ci` explicitly rather than logging false missing-DB
  errors.
- Verified on the final code path: typecheck, lint, migrations, all Vitest
  tests, all 17 Playwright tests and the production build pass.

## Completed (per-event purchase limits — PR #11)

- `Event.maxTicketsPerUser` replaces the old global cap. Existing events
  migrate to the previous default of 10, while admins can configure 1–1000
  tickets per customer/event; PostgreSQL enforces the same range with a
  CHECK constraint.
- `createHold` reads the event-specific cap inside the existing catalogue
  lock and user/event advisory lock, so separate holds or categories cannot
  race past the configured total.
- Admin event create/edit forms expose the setting. Lowering a cap takes the
  exclusive catalogue lock and is refused below the largest quantity already
  committed by any customer (converted reservations + active unexpired
  holds); expired active rows do not artificially block a safe decrease.
- Event creation/updates audit the configured cap and cap changes.
- Regression coverage verifies independent limits on separate events,
  cross-category/concurrent enforcement, converted/expired reservation
  semantics, exact-bound decreases and rejected unsafe decreases.

## Completed (reconciliation admin alert)

- `lib/email/notifications.ts::enqueueReconciliationAlertEmail` enqueues a
  durable `EmailOutbox` row, inside the SAME webhook transaction that
  transitions an order to `paid_but_unfulfillable` or
  `reconciliation_required` — money was captured but no ticket was issued,
  and this no longer depends on an admin happening to check the
  dashboard's attention metrics.
- Every active `admin`/`super_admin` at enqueue time gets its own row
  (`support`/`scanner` are excluded — they can't act on a refund), keyed
  by the same idempotent `entityId = "${orderId}:${adminUserId}"` claim as
  before, so a redelivered webhook event can't double-enqueue any one
  admin's alert. Rebased onto the durable email outbox refactor
  (`fix/email-outbox-durable`): the enqueue call never builds email
  content itself — `lib/email/dispatcher.ts::renderReconciliationAlert`
  re-derives the reason from the order's live status at send time, and a
  provider send failure for one recipient is retried by the dispatcher
  exactly like any other outbox row, closing the two gaps the original
  one-shot `sendReconciliationAlertEmail` design had.
- Resolution itself (fulfil manually or refund) remains a manual admin
  action from the order detail page — only detection/notification is
  automatic now (see docs/PAYMENTS.md's Open decisions).

## Completed (customer phone-completion flow)

- A customer who registered before phone became mandatory (PR #18) had
  `phone: null` and no way to add one, so ChariPay checkout would keep
  cleanly rejecting them (`PAYMENT_CUSTOMER_DETAILS_REQUIRED`, no crash or
  financial risk) with no path forward. `updatePhoneSchema`
  (`lib/validation/auth.ts`) shares the exact same validation rule as
  registration's `phoneSchema` (now extracted as its own export) so a
  later add-a-phone submission is never held to a looser or stricter bar.
- `PATCH /api/customers/phone` (`requireCustomer`-gated, rate-limited)
  lets the signed-in customer set/change their own phone number; the
  update and its `customer.phone_updated` audit entry commit atomically
  (`lib/customers/phone.ts`).
- The checkout page (`CheckoutClient.tsx`) never gates on phone
  speculatively — it only shows the inline phone form after the provider
  itself returns `PAYMENT_CUSTOMER_DETAILS_REQUIRED` from
  `POST /api/checkout/[holdId]/start`, so a provider that doesn't need a
  phone (FakeProvider) is never blocked by this. Submitting the form saves
  the phone then immediately retries checkout.
- **Audit fixes (independent audit, GPT, of the original version of this
  flow):**
  1. **P2 — phone gate accepted values ChariPay's adapter would later
     reject.** `phoneSchema`/`updatePhoneSchema` only checked for
     phone-like characters plus an 8-15 digit count, a separately
     maintained rule from `chariCustomerPhone()`'s actual normalization —
     a value like `"1234567890"` passed the schema but wasn't a
     recognized Moroccan or country-coded number, so it would only fail
     at payment time, by which point the correction form was already gone
     (phone was non-null). Fixed by extracting one shared
     `normalizePhone()` (`lib/validation/phone.ts`) that both the schema
     (storing its canonical E.164 output, not the raw input) and the
     ChariPay adapter now call — the two can no longer drift apart.
  2. **P2 — phone update and its audit entry were not atomic.** The
     original endpoint called `prisma.user.update()` then a separate
     `writeAuditLog()`; an audit-insert failure would 500 after the phone
     had already changed, with no audit record of it. Fixed: both writes
     now run inside one `prisma.$transaction` (`updateCustomerPhone` in
     `lib/customers/phone.ts`).
  3. **P3 — the claimed HTTP-auth test coverage didn't exist.** Added
     Playwright coverage for unauthenticated `PATCH /api/customers/phone`
     (401) and confirmed end-to-end that the endpoint can only ever
     change the signed-in caller's own row (`tests/e2e/access-control.spec.ts`).
  4. Also added: no rate limiting existed on the original endpoint at
     all — added the same per-account allowance pattern used elsewhere
     (10/15min).

## Completed (automated deployment migrations)

- Root cause of the live Preview bug where real ChariPay `payment.succeeded`
  webhooks 500'd with `P2021: table public.email_outbox does not exist`:
  Vercel's default `next build` never runs `prisma migrate deploy`, so a
  merged schema migration only reached a database if someone ran it by
  hand. Fixed with a `vercel-build` script (`prisma migrate deploy && next
  build`) — Vercel automatically prefers this over `build` when present.
- Confirmed this project's Prisma version (7.10.0) has no pooled/direct-URL
  split available: `directUrl` in `schema.prisma`'s datasource block is
  rejected outright ("no longer supported... Move connection URLs to
  prisma.config.ts"), and `prisma.config.ts`'s own `Datasource` type only
  exposes `url`/`shadowDatabaseUrl`. `migrate deploy` therefore runs against
  the same `DATABASE_URL` already used at runtime — see
  `docs/ARCHITECTURE.md`'s "Deployment migrations" section for the reasoning
  and what to do if that specific connection ever can't hold the advisory
  lock `migrate deploy` needs.
- Verified end-to-end locally against a from-scratch database: all 9
  migrations applied via `npm run vercel-build`, `next build` succeeded,
  and a second `prisma migrate deploy` run against the now-migrated
  database confirmed idempotent (`No pending migrations to apply`).
- Still needed, outside this fix's scope: someone with the actual Preview
  environment's Vercel/database access needs to confirm the next
  deployment's build log actually shows the migration running (this fix
  only takes effect on the next deploy to that environment), and rotate
  any database credential that was pasted in plaintext during
  troubleshooting.

## Completed (unbounded orders CSV export)

- Admin order export now keyset-paginates in deterministic
  `(createdAt DESC, id DESC)` order and streams 1,000-row batches instead of
  silently truncating at 20,000 rows.
- CSV escaping/formula-injection protection and UTF-8 BOM behavior are shared
  between the streaming route and the existing in-memory formatter.
- Regression coverage forces several orders to the exact same `createdAt`
  value and crosses multiple tiny batch boundaries to prove no duplicate or
  dropped rows at the tie boundary.

## Completed (fail closed on unverified ChariPay payment.failed webhooks)

- `payment.failed` previously reused `payment.succeeded`'s Amount/metadata
  mapping by extrapolation only — never independently confirmed against a
  real signed delivery — yet could mark the order/payment failed and
  release inventory on that guess.
- `app/api/payments/webhook/charipay/route.ts` now gates `payment.failed`
  closed with `CHARIPAY_PAYMENT_FAILED_WEBHOOK_SHAPE_VERIFIED = false`,
  mirroring the existing `CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED` gate and
  running before the same generic `payloadValid` check for the identical
  reason: a real delivery whose shape differs from the guess must be
  acknowledged for later evidence capture, not rejected as malformed.
- A real `payment.failed` is acknowledged (`202`) with zero
  payment/order/inventory mutation and no failure email enqueued; evidence
  is recorded once per external event id as
  `charipay.payment_failed_shape_unverified` (deduped by `externalEventId`
  directly, since this gate deliberately never resolves a Payment row from
  an unverified body shape).
- `payment.succeeded` and `refund.*` behavior are unchanged.
- Regression coverage: unverified acknowledgment with no mutation,
  malformed/unexpected body still reaches the capture path instead of
  being rejected by guessed payload validation, duplicate/replayed
  delivery records evidence exactly once, invalid signature is still
  rejected before the gate, and the gate never fires for
  `payment.succeeded`/`refund.*`.
- Closes the safety gap for acceptance checklist item 7
  (`docs/CHARIPAY.md`) pending one real signed sandbox capture; flip the
  flag once that delivery is captured and `parseWebhook()` is pinned
  against it.


## Completed (email outbox claim fencing — branch fix/email-outbox-claim-fencing)

- Resend already bounds each provider request to 10 seconds, well below the
  dispatcher's 5-minute reclaim lease. The remaining stale-worker hazard is
  now fenced at database finalization time using the claimed row's existing
  `processingStartedAt` value: every sent/failed/retry/skip transition is a
  conditional `updateMany` that only succeeds while the row is still
  `processing` under the exact lease this worker claimed.
- If a newer worker reclaims or finishes the row after lease expiry, the
  stale worker's eventual provider result cannot overwrite the newer state
  or rewind a sent row back to pending/failed. No schema migration or new
  lock is required.
- Terminal/rescheduled transitions clear `processingStartedAt`, making lease
  ownership explicit once processing ends.
- Regression coverage suspends one worker during `send()`, simulates a newer
  worker reclaiming and completing the same row, then proves the stale worker
  cannot replace the newer provider message id when it resumes.


## Completed (privacy-safe email error codes — branch fix/email-outbox-safe-error-codes)

- The outbox dispatcher no longer persists or logs arbitrary `Error.message`
  text. Render/Prisma/runtime exceptions can contain SQL details, URLs or
  customer data, so untyped exceptions now collapse to the fixed retryable
  code `email_dispatch_internal_error`.
- `EmailProviderError` now enforces a bounded machine-code format. A provider
  adapter that accidentally passes a raw response body or human error message
  is sanitized to `email_provider_error` before the value reaches either
  `lastErrorCode` or application logs.
- Existing Resend errors already use safe machine codes and keep their
  retryable/non-retryable semantics unchanged.
- Regression coverage injects a provider error containing the customer's email
  and a fake secret and proves neither value is persisted or logged.



## Completed (direct Resend runtime guard — branch fix/resend-direct-runtime-guard)

- The Preview-only `RESEND_TEST_RECIPIENT` policy now lives in one shared
  runtime helper used by both `getEmailProvider()` and
  `ResendEmailProvider` itself. Direct construction can no longer bypass
  the factory's fail-closed environment matrix.
- The provider now rejects the redirect in non-Vercel production, Vercel
  Production, and custom Vercel targets; standard Vercel Preview and explicit
  local development/test runtimes remain allowed.
- The provider's shared `@resend.dev` sender check is case-insensitive, matching
  the factory's behavior, so an uppercase/mixed-case sender cannot bypass the
  mandatory test-recipient guard.
- Unit coverage exercises direct construction in those unsafe runtimes and the
  case-insensitive shared-sender check.



## Completed (production app-URL loopback guard — branch fix/app-url-loopback-production-guard)

- Production `NEXTAUTH_URL` now requires HTTPS even for loopback hostnames by
  default. A loopback hostname no longer silently weakens the production URL
  invariant.
- The Playwright `next start` server opts into a narrow
  `ALLOW_HTTP_LOOPBACK_APP_URL_IN_PRODUCTION=true` exception explicitly.
  The exception requires both `http:` and a recognized loopback hostname, so
  the flag cannot exempt a public host or a different URL scheme.
- Unit coverage proves loopback HTTP is rejected without the flag, accepted
  only with the flag, and that neither a public HTTP URL nor a non-HTTP
  loopback URL can use the escape hatch.
- `.env.example` documents the flag as browser-test-only and warns never to
  set it on a real deployment.


## In progress

- **ChariPay real PSP integration — draft PR #13**, now based on current `main`
  including the PR #15 purchase-limit concurrency follow-up. The adapter is derived from ChariPay's
  published v1 API reference, not guessed endpoints: hosted checkout sessions,
  stable `externalId` + idempotency keys, HMAC/timestamp webhook validation,
  `Chari-Event-Id` deduplication, checkout expiry aligned to the OnlyLive hold,
  and asynchronous refunds.
- Real refunds are now designed as a two-phase flow: submitting a refund
  creates a durable `processing` row before network I/O and reserves that
  amount against concurrent refunds; tickets/payment/order/inventory change
  only after a provider-confirmed success. Ambiguous network outcomes remain
  reserved instead of risking a duplicate refund.
- Contract/unit/integration coverage now exercises ChariPay request shapes,
  webhook signature/timestamp/secret rotation, real route dedup/collision and
  financial-integrity checks, sandbox/live deployment guards, asynchronous
  refund reconciliation/replay and historical FakeProvider compatibility.
- ChariPay reconciliation tests avoid pristine-database assumptions; CI runs the complete Vitest suite three times total (one fresh pass plus two additional passes on the same populated database) to catch pollution/order flakes.
- **The signed `payment.succeeded` webhook JSON mapping is now pinned
  against a real sandbox delivery, and verified end-to-end** (captured
  2026-09-17 via ChariPay's partner webhook-events API; the exact stuck
  delivery was then replayed against the fixed code and returned `200`
  with the order confirmed, ticket generated, and confirmation email
  sent). It revealed the guessed shape used until now was wrong in a way
  that silently broke every payment: ChariPay's own generated fields are
  PascalCased, and `ExternalId`/`Reference`/`CustomData` all carry the
  ORDER id rather than the Payment id despite the misleading name — only
  `metadata.onlylivePaymentId` reliably resolves the Payment row, and
  `metadata.onlyliveOrderId` is now a **required** second reconciliation
  invariant for payment events (not merely an optional cross-check —
  `payloadValid` rejects a payment webhook missing either id).
  `parseWebhook` and all four affected test suites
  (`charipay-webhook.test.ts`, `charipayProvider.test.ts`,
  `charipayHardening.test.ts`, `charipayWebhookRotation.test.ts`) are
  fixed and re-verified against the real shape; see docs/CHARIPAY.md's
  "Webhook verification" section for the full mapping. `payment.failed`
  applies the identical interpretation by extrapolation only — it has
  not itself been captured from a real delivery.
- **Refund webhooks now fail closed rather than guess — and the gate
  runs in the right place.** The `refund.*` shape is still completely
  unverified — only `payment.succeeded` has been captured — so finalizing
  a refund from a guessed field mapping would violate this project's own
  "never invent provider fields" rule and risk a silent amount/reference
  mismatch on real money movement.
  `app/api/payments/webhook/charipay/route.ts`'s
  `CHARIPAY_REFUND_WEBHOOK_SHAPE_VERIFIED` flag (currently `false`) gates
  the whole refund-matching path, and — fixed in this round, after GPT's
  audit caught it — this check now runs **before** the generic
  `payloadValid` gate, keyed only on already-confirmed envelope facts
  (event type, event id). `payloadValid` itself depends on the unverified
  guessed refund fields, so checking it first would have 400-rejected a
  real refund whose actual shape differs from the guess instead of
  acknowledging it for reconciliation — exactly the failure mode this
  gate exists to prevent. Every `refund.succeeded`/`refund.failed` event,
  however shaped, is now acknowledged (`202`, audit-logged) without ever
  reaching `finalizeRefundSuccess`/`finalizeRefundFailure`, so a real
  refund stays `processing` pending **authenticated provider-status
  reconciliation** (`lib/orders/refundReconciliation.ts` independently
  polls ChariPay's `getRefundStatus()` API, not the webhook) or manual
  attention — not bare "manual reconciliation" as previously stated here,
  since the automatic poller already exists. PR #13 stays draft until a
  real refund delivery is captured, the flag flips, and the final
  independent audit is complete.

## Completed (naive-timestamp vs now() skew — branch fix/naive-timestamp-now-skew)

Found while setting up a local test database for the first time in this
environment (no `TEST_DATABASE_URL`/Postgres had ever been available here
before): `npm test` failed 11 tests on a freshly `initdb`'d local Postgres
16 cluster, all in the purchase-limit/hold-expiry/inventory-concurrency
area — the exact tests CLAUDE.md calls out as mandatory. CI was, and still
is as of this writing, green on the same code.

Root cause: every `DateTime` column in `prisma/schema.prisma` maps to a
Postgres `timestamp` **without** time zone (confirmed: zero
`@db.Timestamptz` usages in the schema, and every migration emits
`TIMESTAMP(3)`, e.g. `reservations.expires_at`). Several raw-SQL queries
across the codebase compare or write that kind of column using bare
`now()`, which returns `timestamptz`. Comparing/assigning a `timestamptz`
to a naive `timestamp` implicitly casts it through the **session's
`TimeZone` GUC** first. My local cluster's `initdb` picked up this
machine's OS locale and defaulted to `Africa/Casablanca` (UTC+1) — CI's
`postgres:16` container defaults to UTC, which is why this was invisible
there. Concretely, with a naive `timestamp` value `X` written the normal
way (a JS `Date`, via Prisma, always true UTC digits):
- `X < now()` implicitly becomes `X < now()::timestamp`, and `now()::timestamp`
  is the **session-timezone wall-clock** reading of the current instant —
  1 hour ahead of true UTC here. A reservation that still has 14 minutes
  left before its real 15-minute expiry already looked expired.
- The inverse direction (`X >= now()`) under-counts active holds by the
  same mechanism — this is exactly why the purchase-limit tests failed:
  `createHold`'s per-user total query counted zero of the customer's
  already-active holds, so the cap could never trip.

Verified fixed, not just silenced: reverting each fix individually
reproduces the original 11 failures again; `git stash`-testing confirmed
one separately-observed failure (`checkout-reconciliation.test.ts`'s
"leases provider work" test, a hang) reproduces identically with or
without this fix and is a pre-existing flake unrelated to this bug —
tracked below, not fixed here.

Fixed by rewriting the bare `now()` at each vulnerable site (mixing a
JS-Date-written column with a raw-SQL comparison/write) to
`(now() AT TIME ZONE 'UTC')`, which is correct regardless of the server's
configured `TimeZone`:
- `lib/inventory.ts` — `releaseExpiredAndLock` (hold-expiry sweep inside
  `createHold`'s critical section), the per-user purchase-limit total
  query, and `sweepExpiredHolds`.
- `lib/orders/checkoutReconciliation.ts` — the expired-checkout claim's
  `expires_at`/lease checks (the lease-skew direction could have let a
  second worker reclaim a payment before its lease truly expired — a
  double-reconciliation risk, not just a wrong-answer one).
- `lib/orders/refundReconciliation.ts` — the claim lease write (was
  writing skewed values, delaying a stuck refund's next retry by the
  server's UTC offset).
- `lib/email/dispatcher.ts` — retried rows' `nextAttemptAt` readiness
  check (backoff could fire early by the offset).
- `lib/admin/catalog.ts` — both committed-quantity queries gating a
  purchase-cap/phase-limit decrease (an admin could have lowered a cap
  below what customers actually held).

Deliberately **not** changed: `lib/orders/checkout.ts`'s
`provider_init_at` claim writes and compares using bare `now()` on
**both** sides consistently, so the skew cancels in the subtraction —
confirmed by direct calculation, left as-is per "don't rewrite working
code without reason." An independent audit (GPT) confirmed this reasoning
is sound but flagged it as violating the codebase's own UTC-digits
invariant (fragile, not incorrect today) — tracked below, not fixed here.

Durable regression guard: `.github/workflows/ci.yml`'s Postgres service
now sets a deliberately non-UTC `TZ` instead of the image's UTC default,
so CI's existing test suite — not a new, narrower unit test — continues to
exercise this exact scenario for any future code, not just today's fixed
sites. Initially set to `Africa/Casablanca`; the same audit pointed out
this only needs a reliably nonzero, DST-free offset and Morocco's own DST
history makes it a less certain permanent choice for that specific job, so
switched to `Asia/Kolkata` (fixed +05:30, no DST) — also a bigger offset,
making a regression harder to miss against short windows like the
15-minute hold or 30-second reconciliation lease. `tests/setup.ts` now
also asserts (CI only, via `CI=true`; never enforced on a contributor's
own local database) that `current_setting('TimeZone')` is genuinely
non-UTC, so this guard cannot silently regress to UTC without a test
failure — an independent audit (GPT) suggested this after noting the
protection itself needs its own regression guard. (A lower-level
standalone regression test was attempted and discarded: it used `pg` to
bind a raw SQL parameter directly, which is cast differently than how
Prisma actually serializes a `DateTime` write, so it didn't faithfully
reproduce the real code path and would have given misleading signal.)

**Independent audit (GPT) of this fix caught one more real bug it
introduced**: fixing `lib/email/dispatcher.ts`'s claim query to
`next_attempt_at <= (now() AT TIME ZONE 'UTC')` is correct for *retried*
rows (rescheduled from JS, true UTC) but newly *enqueued* rows relied on
the schema's `@default(now())` — `CURRENT_TIMESTAMP`, evaluated
server-side and subject to the exact same skew. Left as a bare comparison
fix alone, a brand-new email on a positive-offset server would look
scheduled up to that offset **in the future**, delaying its first dispatch
attempt. Fixed: `lib/email/notifications.ts`'s `enqueue()` and
`enqueueReconciliationAlertEmail()` now pass `nextAttemptAt: new Date()`
explicitly at insert time (both `emailOutbox.createMany` call sites),
matching the retry path's convention instead of relying on the DB default.

Typecheck, lint and the full Vitest suite (including
`tests/integration/notifications.test.ts`) verified locally against the
non-UTC cluster (301/301 excluding the pre-existing flake below).

**Follow-ups from the same audit, since fixed** (both were lower severity
and didn't block the P1 fix, but were quick and low-risk once identified):
- `app/api/payments/webhook/charipay/route.ts` and
  `app/api/payments/webhook/fake/route.ts` both wrote
  `payment_events.received_at` using bare `now()` — an audit-log
  timestamp-accuracy skew, not a business-logic bug (nothing compares
  `received_at` against another value), but inconsistent with the
  UTC-digits convention everywhere else. Now pass an explicit JS `Date`
  parameter, like every other naive-timestamp write in the codebase.
- `lib/orders/checkout.ts`'s `provider_init_at` claim (self-consistent
  before, not actually broken — see above) now writes via JS `Date` and
  compares via `(now() AT TIME ZONE 'UTC')`, so the invariant "naive
  timestamps here are always UTC digits" is actually true rather than
  true-by-coincidence. Full Vitest suite re-verified after both changes
  (301/301 excluding the pre-existing flake below).

**Still not fixed, deliberately deferred**:
- Longer-term: seriously consider migrating instant-like columns
  (`expires_at`, `updated_at`, `next_attempt_at`, etc.) to
  `@db.Timestamptz(3)`, which would make this entire bug class impossible
  by construction instead of relying on every raw-SQL site remembering
  `AT TIME ZONE 'UTC'`. Any such migration needs an explicit
  UTC-preserving `USING ... AT TIME ZONE 'UTC'` for existing data, not
  Postgres's session-dependent default conversion — a real migration to
  plan deliberately, not a quick follow-up.

## Next

0. **Resolved, was never a code bug**: an earlier draft of this file
   reported `checkout-reconciliation.test.ts`'s "leases provider work"
   test hanging/misbehaving non-deterministically and speculated about a
   `@prisma/adapter-pg` connection-pool issue. Actual root cause, found
   while resyncing this branch with the real remote history and running
   the full suite for the first time against it: `reconcileExpiredCheckouts`
   claims its batch (`claimNextExpiredCheckoutPayment`, batch size 1,
   oldest-due-first) from the **whole** `orders`/`payments` table, not
   scoped to any one test's own fixture. A local dev Postgres instance that
   is never truncated between runs accumulates a large backlog of
   already-expired "checkout" rows from previous test runs (121 found here
   after a full day of testing) — enough of them satisfy the claim query
   that a `reconcileExpiredCheckouts(1)` call in a later test can claim a
   **stale row from an earlier run** instead of the fixture the current
   test just created, producing exactly the "sometimes right, sometimes
   wrong, order-dependent" symptom observed (confirmed: `TRUNCATE`ing the
   transactional tables in the local test database made every run — full
   suite and isolated — pass consistently, including two other
   ledger-reconciliation tests that briefly looked broken while this was
   diagnosed). Not a codebase defect; a local test-environment hygiene gap
   (this repo's own test database is otherwise treated as ephemeral/CI-only
   and normally never accumulates a real backlog). No code change made.
   Worth a follow-up at some point: either `claimNextExpiredCheckoutPayment`
   could scope more defensively, or (simpler) local dev docs should note
   that a long-lived local Postgres for this suite should be truncated
   periodically — genuinely low priority, since CI's disposable database
   never has this problem.
1. Finish validating PR #13 against the real ChariPay sandbox account: the
   webhook endpoint is registered, a synthetic event was captured, and a
   real successful hosted checkout's `payment.succeeded` webhook is now
   captured and pinned (see above). Still needed: a real payment failure,
   a real refund success/failure (full and partial) with its webhook
   payload pinned, and a webhook-delivery/`refundReference` replay test

   **Attempted and inconclusive (2026-09-18):** tried to force a payment
   failure via a hosted checkout using card `4000000000000002` (shown as
   a "Refus" test card in ChariPay's own hosted-checkout UI copy), which
   returned a real browser-return `RESPONSE_CODE=25`/`REASON_CODE=
   AUTHORISATION REJECTED`. Independently confirmed via GPT (which checked
   both ChariPay's current published sandbox docs and this project's
   Vercel runtime logs) that this was the wrong test: **this repo's own
   existing note two lines above item 6 in the "Required sandbox
   acceptance" checklist already established that the sandbox only
   accepts one documented test card (`4918914107195005`/CVV `123`/3DS
   `555`) and rejects every other PAN upstream** — should have
   cross-checked that before picking a card from the checkout page's UI
   hint instead. Vercel logs confirm zero requests ever reached
   `/api/payments/webhook/charipay` in that window: this was an
   upstream PAN rejection, not a delayed/stuck webhook delivery, and is
   not evidence of the provider's documented delivery-queue defect
   either. No code or docs changed based on this result (correctly, per
   GPT — the `AUTHORISATION REJECTED` return is real but doesn't
   represent the kind of failure ChariPay's `notifyOnFailure` /
   `payment.failed` path is documented to fire for). Next attempt should
   use the documented success card but a **deliberately wrong 3DS code**
   (not `555`) or an abandoned/timed-out 3DS challenge, to reach a
   genuine decline within the recognized card-processing path rather
   than an upstream PAN rejection.
   against the real provider.
2. Activate the Resend transactional-email account/domain and run a real
   delivery/bounce smoke test. The provider adapter is now implemented from
   Resend's official API contract, forwards the EmailOutbox id as the provider
   idempotency key, and distinguishes retryable from permanent provider
   failures. Production still needs RESEND_API_KEY + a verified
   RESEND_FROM_EMAIL; no real credentials are committed.
3. Decide the production managed-Postgres provider and document/test the
   backup/restore strategy required by `CLAUDE.md`.
4. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
   requires OnlyLive's accountant/lawyer and the eventual PSP requirements.
5. Stage Vercel WAF rate-limit rules in log mode before production, observe
   real traffic, then tune/enforce without replacing account-level limiting.
6. Before production rollout, smoke-test admin login/logout, catalogue
   mutation and scanner validation on the real Vercel preview/custom domain.

## Blocked

- ChariPay sandbox API key, webhook signing secret, and public HTTPS
  preview URL are obtained and end-to-end payment.succeeded validation is
  done (see "In progress" above and docs/CHARIPAY.md's checklist) — no
  longer blocking. Still open: a real `payment.failed` and real refund
  success/failure captures, both requiring only more sandbox exercises, not
  new credentials. Real production go-live additionally requires OnlyLive
  merchant/KYB approval and live credentials; no production secret should
  be committed or pasted here.
- Real email delivery is blocked on creating/configuring the Resend account, verifying the sending domain, and adding production credentials.
- Legal document drafting is blocked on legal/accountant review and ChariPay's
  final merchant/go-live requirements.

## Deferred (explicitly out of scope, per CLAUDE.md)

- Offline scanning / multi-device offline reconciliation.
- General background-worker infrastructure beyond the current sweep endpoint
  and the targeted retry/alert jobs explicitly added to `Next` above.
