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



## Completed (ChariPay provider diagnostic privacy — branch fix/charipay-provider-error-log-privacy)

- ChariPay API response prose is no longer copied into
  `ProviderRequestError.message`. Provider-controlled text can echo request
  values, so thrown messages now contain only an OnlyLive-owned fixed phrase
  plus a validated machine code.
- Checkout initialization no longer logs `ProviderRequestError.message` at
  all. Its structured diagnostics are limited to outcome/status plus bounded
  provider code, field hint and correlation id.
- Provider error codes are accepted only as 1–64 character machine tokens;
  malformed/untrusted values collapse to `HTTP_<status>`. Correlation ids
  are likewise accepted only as bounded diagnostic tokens or dropped.
- The existing sandbox-only `providerMessageHint` remains the sole place where
  provider prose can survive, and only after the existing redaction pass.
- Unit coverage injects email/secret-like data into provider message, code and
  correlation fields and proves the thrown diagnostics do not retain it.



## Completed (ChariPay webhook payload minimization — branch fix/charipay-webhook-payload-retention)

- OnlyLive no longer persists full ChariPay webhook bodies in
  `payment_events.raw_payload` or the unverified-shape audit records.
  Provider payloads are third-party controlled and may gain customer/provider
  fields over time; storing the whole signed body created unnecessary
  long-lived data exposure.
- New ChariPay event records retain only versioned evidence: a SHA-256
  fingerprint of canonical JSON plus the top-level field count. Even JSON
  property names are provider-controlled, so no provider field names or values
  are retained. The fingerprint is sufficient for duplicate/event-collision
  consistency checks; exact shape diagnostics come from ChariPay's journal.
- Collision/replay logic is backward compatible with historical rows that
  contain the old full JSON: those legacy values are fingerprinted on read, so
  no data migration is required and an old event can still be retried safely.
- Exact provider bodies needed to pin a newly observed webhook shape remain
  available from ChariPay's own authenticated webhook-events journal rather
  than being duplicated indefinitely in OnlyLive.
- Integration coverage proves verified events, payment.failed shape evidence
  and refund shape evidence omit injected customer-like values and even
  customer-like JSON property names while
  duplicate/collision behavior (including a legacy full-body row) is preserved.



## Completed (ChariPay unsigned webhook-header integrity — branch fix/charipay-unsigned-event-header-integrity)

- ChariPay's documented HMAC covers `timestamp + "." + rawBody`; the
  `Chari-Event-Type` and `Chari-Event-Id` delivery headers are outside that
  signed string. A valid signed body therefore must not be allowed to mutate
  money/tickets solely because an unsigned header labels it
  `payment.succeeded`.
- For every new/unprocessed payment event that reaches the financial path,
  OnlyLive now requires ChariPay's authenticated transaction ledger lookup to
  independently confirm the header-claimed outcome against the same Order id,
  amount, currency and the already-pinned `PAYMENT` / `IN` invariants before
  fulfillment/failure is allowed.
- An identical already-processed event short-circuits as a duplicate without a
  provider API call. A terminal opposite ledger outcome is acknowledged as a
  reconciliation-required contradiction with no mutation; pending/not-found/
  ambiguous or lookup failures return 503 so provider retry and independent
  reconciliation can recover safely.
- `payment.failed` remains behind its existing real-payload shape gate, but
  once that gate is lifted it is also protected by the same authenticated
  ledger outcome check. Refund webhooks remain fully fail-closed behind their
  own unverified-shape gate and must gain the equivalent authenticated refund
  status binding before that gate is ever enabled.
- Integration coverage proves genuine success requires the authenticated
  lookup, a header-claimed success cannot issue tickets when the ledger says
  failed, lookup outages/pending state fail closed, and exact duplicates do
  not consume an extra provider lookup.

## Completed (email dispatch scheduling — issue #48, PRs #52/#53/#54)

Real ChariPay sandbox purchases and Resend delivery already worked before
this; the outstanding gap was that nothing reliably called
`dispatchPendingEmails()` at all outside of manual testing (Vercel Hobby's
native cron only runs once/day — too infrequent for order-confirmation
email).

- **PR #52 — eager dispatch trigger.** `lib/email/eagerDispatch.ts` wraps
  `after()` (from `next/server`) around `dispatchPendingEmails()`, called
  from the 5 places that enqueue a customer-facing email: both webhook
  handlers, the expired-holds sweep, admin manual fulfillment, and the
  customer's own payment-reconciliation poll route (gated —
  `if (result.reconciled)` only — so routine ~5s poll traffic never
  triggers a dispatch scan). `after()` throws synchronously outside a real
  Next.js request scope; the wrapper swallows that and logs only a fixed
  safe code, never the raw exception (a privacy regression GPT's audit
  caught and had fixed before merge). This is the near-real-time delivery
  path; the scheduler below is the backstop for whatever it misses.
- **PR #53 → #54 — GitHub Actions scheduler, `main`'s
  `.github/workflows/dispatch-emails-cron.yml`.** Runs every 5 minutes
  (GitHub's documented minimum interval; best-effort, not guaranteed),
  calling `/api/internal/dispatch-emails` and failing the run (red X) on
  any `permanentlyFailed` row or a response that doesn't validate as
  `{claimed,sent,retried,permanentlyFailed,skipped}` all non-negative
  integers.
  - **PR #53's real-world failure, found only by an actual
    `workflow_dispatch` run, not by review:** Vercel's own Deployment
    Protection (SSO wall) 302-redirects any unauthenticated caller to
    `vercel.com/sso-api` *before* the request ever reaches the app's own
    `X-Internal-Secret` check — a platform-level auth layer, completely
    separate from and in front of the app's. An earlier claim of having
    "verified" the endpoint was invalid: that test ran through an
    authenticated browser session carrying a Vercel SSO cookie, which a
    bare `curl` (what GitHub Actions actually sends) does not have.
  - **PR #54's fix:** GitHub Actions OIDC (`actions/github-script`'s
    `core.getIDToken()`, `permissions: id-token: write`) sent as
    `x-vercel-trusted-oidc-idp-token`, verified by Vercel's "Trusted
    Sources" feature (Project Settings → Deployment Protection → Trusted
    Sources → GitHub Actions, scoped to this repo, branch `main`,
    environment Preview) — chosen over a second static
    "Protection Bypass for Automation" secret since it needs no long-lived
    credential. Pinned to the exact `actions/github-script` commit SHA
    GPT's audit specifically vetted (`60a0d83…`, v7.0.1) rather than
    whatever the mutable `v7` tag currently points at (confirmed
    `dist/index.js`/`src/main.ts` genuinely differ from v7.1.0 — "pinned
    to an immutable SHA" and "pinned to the SHA someone actually audited"
    are not the same guarantee).
  - **Real end-to-end verification, not just green CI:** a
    `workflow_dispatch` run against `main` post-merge returned genuine
    dispatcher JSON (`{"claimed":0,"sent":0,"retried":0,
    "permanentlyFailed":0,"skipped":0}`), confirmed by reading the actual
    run log, not just its pass/fail status. A no-OIDC-token baseline run
    (the pre-merge workflow) still hit the SSO wall's `"Redirecting..."`,
    confirming Trusted Sources doesn't open the door for non-OIDC
    requests either.
  - **A self-inflicted false alarm during testing, worth recording:**
    dispatching the OIDC-enabled workflow against the PR's own feature
    branch (to avoid touching `main` pre-merge) also hit the SSO wall —
    not a Vercel bug, but because Trusted Sources exactly matches every
    configured claim including the branch, and the rule is (correctly)
    scoped to `main` only, since GitHub only ever evaluates `schedule`
    triggers from the default branch anyway.
  - Also caught in GPT's audit before merge: a temporary debug step added
    during troubleshooting called the real `dispatch-emails` endpoint a
    second time per run (the production step ran again right after),
    double-invoking a stateful, side-effecting endpoint — removed before
    merge (verified the merged file is byte-identical to the previously
    audited commit).
  - Note on process, not substance: GPT cannot submit a formal GitHub
    "Approved" review on this repo — its connected GitHub identity is the
    same account as the PR author, and GitHub blocks self-approval/
    self-request-changes. Its audits are recorded as `COMMENTED` reviews
    with explicit pass/fail findings instead; treat those, not the GitHub
    review-decision field, as the real audit record here.
- **PR #56 — real GitHub-side schedule-registration bug, found only by
  actually watching the run history, not by review.** After #54 merged,
  the `schedule` trigger fired **zero times in 2.5+ hours** (~31 missed
  5-minute windows), despite the workflow reporting `active`, the repo
  being public/non-fork/non-archived, Actions permissions allowing all,
  and the correct `schedule:` block being present on `main`'s HEAD.
  Independently confirmed by a second GPT session directly querying
  `repos/.../actions/runs?event=schedule` (`total_count: 0`) — matching
  the exact signature of real 2026 GitHub Community reports of a
  scheduler-registration bug (manual dispatch works, valid cron, GitHub
  simply never emits the `schedule` event). Fix: changed the cron from
  `*/5 * * * *` to `2-59/5 * * * *` — same 5-minute cadence, offset off
  the round `:00/:05/:10...` boundaries. This is *not* a documented
  guarantee (GitHub's docs only promise cron-expression changes reactivate
  a formally *deactivated* workflow, and this one reported as merely
  `active`), only a reasonable attempt at the actual observed fault — a
  wording overclaim GPT's audit caught and had corrected before merge.
  It worked: the schedule trigger began firing within the next few
  windows.
- **Real end-to-end confirmation, both open items closed:**
  - A genuine unattended purchase (real ChariPay sandbox card, real
    signed webhook, `POST /api/payments/webhook/charipay 200`) delivered
    its confirmation email via the eager `after()` trigger alone, with
    zero manual `/api/internal/dispatch-emails` calls at any point.
  - As of 2026-09-22, 13 genuine `event: schedule` runs have completed
    successfully since the PR #56 fix, the most recent returning real
    dispatcher JSON (`{"claimed":0,"sent":0,"retried":0,
    "permanentlyFailed":0,"skipped":0}`), confirmed from the actual run
    log.
  - **Observed cadence caveat, worth recording honestly:** the 13 runs
    are spaced roughly 2–5 hours apart, not every 5 minutes as
    configured — GitHub is evidently still dropping the large majority of
    windows for reasons not exposed by GitHub (the missed runs are
    proven; the specific cause is not — don't overclaim a specific
    load/tier explanation we can't actually verify).
    This matches the workflow's own documented caveat ("best-effort, can
    be delayed or silently dropped") taken to a further extreme than
    expected. Not re-chased further: the eager `after()` trigger (PR #52)
    remains the actual near-real-time delivery path in every normal case;
    this scheduler is strictly the backstop for whatever that path
    misses, and firing every few hours instead of every 5 minutes still
    closes that gap far better than the zero-runs status quo it replaced.
    If this ever matters more (e.g. once real production volume makes a
    multi-hour stuck-email window unacceptable), the next step is a
    GitHub Support ticket referencing workflow ID `362547657`, not
    further changes to this app's own code. Do not describe this
    scheduler elsewhere as a "5-minute recovery guarantee" — if eager
    dispatch ever fails with no subsequent purchase to trigger another
    global dispatch, an affected email can genuinely sit for hours before
    this backstop runs. Defensible for the current MVP given the
    architecture chosen, but a real characteristic to keep accurate.
  - Case not independently live-tested: OIDC-token-present-but-
    `X-Internal-Secret`-absent returning an app-level 401. Not pursued
    further — this is guaranteed by existing, already-tested application
    code (the app's own secret check is unrelated to and unaware of the
    Vercel-layer OIDC header), and adding another live probe here would
    mean either a temporary workflow step invoking real production
    endpoints again (the exact side-effect risk PR #56's own debug-step
    incident already illustrated) or weakening this app's own auth for a
    test, neither of which was judged worth it for an already-covered
    code path.
- Issue #48 closed 2026-09-22 with this evidence.

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

## Completed (Resend + ChariPay preview end-to-end smoke test — 2026-09-19/20)

- First real, human-driven proof of the full paid-order chain on a live
  Vercel Preview deployment (`feat/charipay-integration`, commit `8fd422b`):
  real customer signup/login → real reservation/hold → real ChariPay
  **sandbox** hosted checkout (documented test card, no real money) →
  signed webhook → order `paid` → ticket issued (`Statut : Valide`) →
  durable `EmailOutbox` row → `POST /api/internal/dispatch-emails` →
  Resend → delivered to a real inbox and confirmed received by the user.
- Dispatcher call 1: `{claimed:1, sent:1, retried:0, permanentlyFailed:0,
  skipped:0}`. Dispatcher call 2 (immediately after, same backlog):
  `{claimed:0, sent:0, ...}` — confirmed idempotent, no duplicate send.
- Also drained a **pre-existing** backlog of 6 queued-but-unsent emails
  from earlier development/testing before the real purchase, which is what
  surfaced the finding below.
- **Real gap found, not just a smoke-test artifact**: `vercel.json` only
  defines a cron for `/api/internal/sweep-expired-holds`; there is no
  scheduled trigger for `/api/internal/dispatch-emails` at all. The durable
  outbox itself is correct, but nothing was actually calling the dispatcher
  in this environment — the 6 stuck emails are direct proof. Filed as
  GitHub issue #48 (GPT). Do not consider Resend delivery production-ready
  until #48 is resolved.
- **Also found**: ChariPay's post-payment browser return redirect (never
  authoritative — the signed webhook is what actually confirmed payment
  here) pointed at a stale/misconfigured URL
  (`onlylive-events-git-feat-charipay-ebf143-...vercel.app`) that 404'd.
  Cosmetic only — the real confirmation path was unaffected — but a real
  customer would land on a 404 immediately after paying. Not yet filed as
  its own issue; raised with GPT to fold into #48 or its own small PR.
- Sender was still the shared `onboarding@resend.dev` address with
  `RESEND_TEST_RECIPIENT` forcing delivery to one real inbox for this test
  — this proves the delivery *mechanism*, not a verified production sending
  domain. A verified `RESEND_FROM_EMAIL` domain remains required before
  real customers can be emailed; see item 2 under "Next" below (only
  partially resolved by this entry — the pipeline is proven, the domain is
  not).

## Completed (legacy reconciliation-attention duplicate cleanup — PR #50, closes #44)

- Before `recordPaymentReconciliationAttention()` gained its advisory
  transaction lock (#42), concurrent writers could each pass a
  read-then-create race and leave more than one
  `payment.checkout_reconciliation_required` `AuditLog` row for the same
  Payment. The lock prevents new duplicates going forward but never touched
  historical ones — this was tracked as low-priority (#44) since it carries
  no forward correctness or money/ticket risk.
- `scripts/mergeReconciliationAttentionDuplicates.ts` finds any such
  pre-existing duplicate groups and merges each into one canonical row:
  earliest row's id kept, `firstReason` from the earliest row, `occurrences`
  summed, and the "current" `reason`/extra fields promoted from a
  best-effort proxy (highest `occurrences`, since `AuditLog` has no
  `updatedAt` and `createdAt` cannot prove which row was touched most
  recently). Defaults to a dry run; `--apply` actually merges/deletes.
- **Not yet run against any live database.** Deliberately built and tested
  only against the local test database — nobody in this agent-assisted
  session pulled the Preview/production `DATABASE_URL` to check how many
  real duplicates exist or to apply the fix. Whoever has direct DB access
  should run the dry run first to see if any real duplicates even exist
  before deciding whether `--apply` is worth running at all.
- Two rounds of independent cold audit (GPT) on this PR caught real
  correctness bugs before merge, both now fixed and regression-tested:
  (1) the apply path originally read rows before its transaction and never
  took the same advisory lock the forward-going helper uses, so a
  concurrent live observation could have been silently overwritten by
  stale precomputed metadata; (2) the first archival design embedded
  original-row snapshots inside the canonical row's own metadata, which
  `recordPaymentReconciliationAttention()` replaces wholesale on its very
  next ordinary observation — the archive is now a separate, distinct
  AuditLog action that helper never reads or writes, immune to being
  clobbered by construction rather than by convention.

## Completed (eager email dispatch trigger — half of #48, does not close it)

- **This is only the happy-path-latency half of #48; the issue stays open.**
  Every transactional email currently still depends on someone/something
  calling `dispatch-emails`. The 2026-09-19/20 smoke test proved the pipeline
  works end-to-end, but also proved nothing was actually scheduled to call it
  — this entry does not fix that gap, it just closes most of the practical
  latency users would experience before it's fixed.
- Confirmed via `dispatch-emails/route.ts`'s own existing comment and current
  Vercel docs: this project is on Vercel Hobby, where cron jobs run once/day
  and Vercel does not retry a failed cron invocation. Also confirmed (and
  corrected an outdated assumption from the initial proposal): Vercel now
  allows up to 100 cron jobs per project on every plan as of January 2026 —
  only the once-daily frequency cap is Hobby-specific.
- Added `lib/email/eagerDispatch.ts`'s `scheduleEagerEmailDispatch()`: wraps
  `after(() => dispatchPendingEmails())` so a customer's confirmation email
  goes out within seconds of a successful purchase instead of waiting for
  the next periodic run. `after()` executes only after the response is
  already sent, so it can never add latency to a webhook or risk ChariPay's
  documented ~10s redelivery threshold, and a thrown/rejected dispatch is
  always swallowed and logged, never allowed to affect the caller's own
  response.
- Wired at every call site that can create a new `EmailOutbox` row, not just
  the ChariPay success webhook (full inventory, per audit request — GPT's
  cold audit caught one omission, the customer-triggered reconcile-payment
  route, before merge):
  `app/api/payments/webhook/charipay/route.ts`,
  `app/api/payments/webhook/fake/route.ts` (dev/test provider),
  `app/api/internal/sweep-expired-holds/route.ts` (covers both
  `reconcileExpiredCheckouts()` and `reconcileProcessingRefundsFair()`),
  `app/(admin)/admin/orders/[orderId]/actions.ts`'s admin-initiated refund
  Server Action, and `app/api/orders/[orderId]/reconcile-payment/route.ts`
  (the customer's own on-demand "check my payment" polling endpoint, which
  can finalize a recovered payment via the same
  `finalizeRecoveredPayment()` the batch worker uses).
- **Explicitly does not replace the periodic dispatcher.** `after()` throws
  synchronously when called outside a real Next.js request/Server Action
  scope (confirmed empirically — every existing webhook/route test invokes
  the exported handler directly, with no real server, so this is the actual
  behavior the whole test suite already exercises), and a crash between an
  outbox row's creation and `after()` actually running is exactly the
  recovery case a periodic scheduler exists for. The periodic
  `dispatch-emails` endpoint is unchanged and must still be wired to a
  real recurring trigger to close #48 — that decision (Vercel Pro cron vs.
  an authenticated external scheduler such as GitHub Actions) needs the
  user's approval, since either costs money or adds `CRON_SECRET` to a
  third-party service.
- The `reconcile-payment` route is gated on `result.reconciled`, not
  unconditional — this endpoint is polled roughly every 5s while a checkout
  is pending, and `reconciled: false` (nothing changed, no outbox row
  created) is the overwhelmingly common result; scheduling a global dispatch
  scan on every such poll would turn ordinary polling into repeated
  unnecessary background work. Caught by GPT's cold audit before merge.
- Test coverage: unit tests for `scheduleEagerEmailDispatch()` covering the
  registration/rejection/outside-request-scope paths via a mocked
  `next/server`, plus a privacy-sentinel test proving a dispatch-level
  failure containing a fake secret/customer string never reaches
  `console.error` — only the fixed safe code does (this exact regression
  was caught by audit before merge: the first version logged the raw
  exception message); an explicit charipay-webhook integration test proving
  the webhook still returns success and confirms the order even though the
  eager trigger cannot register in a test context; a dedicated route test
  proving the `reconcile-payment` gate (no-op poll never schedules, an
  actually-recovered payment does); and a concurrency test proving
  `dispatchPendingEmails()`'s existing `FOR UPDATE SKIP LOCKED` claim
  (unmodified by this change) still guarantees no double-send/dropped row
  when two dispatch calls now genuinely race — an eager trigger overlapping
  the periodic sweep, or two eager triggers from two near-simultaneous
  webhook deliveries. That test's first version drained the entire shared
  backlog before seeding its own rows to make itself deterministic, which
  audit correctly flagged as unsafe (it would send/mutate unrelated rows
  belonging to other, possibly concurrently running, test files); fixed by
  pinning only the test's own two rows to the earliest possible
  `nextAttemptAt` and scoping every assertion to their specific idempotency
  keys instead of the dispatch summaries' global totals.

## Completed (backup/restore-drill scripts — PR #69, merged 2026-09-22)

- `docs/DATABASE_RECOVERY.md`'s "Layer 2" and "Restore drill" sections had
  only inline bash snippets, no committed runnable script. Added
  `scripts/backup-database.sh` (dump + checksum) and `scripts/restore-drill.sh`
  (checksum verify + `--clean` restore + `recovery-smoke.sql` invariant check),
  and ran the full pipeline end-to-end against a real, throwaway, local,
  non-application Postgres cluster before ever proposing a merge.
- That local run found and fixed two real bugs in the doc's original inline
  commands: `pg_dump`/`psql` both mishandle a bare positional connection
  string ahead of further flags on at least one real build (confirmed on
  Windows), but differently — `pg_dump` fails outright with a misleading
  "too many command-line arguments" error that misattributes the failure to
  the flag itself; `psql` is the worse case, since it silently ignores
  every flag after the positional argument, including `ON_ERROR_STOP` and
  `-f`, so the invariant check would never actually run with no visible
  error at all. Fixed both by using `-d "$URL"` explicitly.
- GPT's independent cold audit (required before merge per this project's
  standing rule) then found and confirmed four further real gaps across two
  review passes, all fixed and re-verified end-to-end before merging:
  1. both scripts were committed with git mode `100644` (non-executable),
     which would fail with `Permission denied` since the docs invoke them
     directly on a normal Linux runner — fixed to `100755`;
  2. the restore script's checksum check only warned and proceeded when
     `<dump>.sha256` was missing, contradicting its own fail-closed safety
     model — changed to refuse by default, with
     `RESTORE_DRILL_ALLOW_UNVERIFIED=yes` as the sole explicit override;
  3. `pg_restore --clean` does not guarantee a pristine target (it only
     drops objects present in the dump archive itself) — added a required
     `RESTORE_DRILL_TARGET_IS_FRESH=yes` confirmation gate rather than
     attempting to solve this with `--create`, which changes required
     privileges and database-naming semantics;
  4. the checksum hashed the dump's full path, not a portable bare
     filename, which would silently break verification once a backup was
     copied to independent storage or a different host/path (the entire
     point of these backups) — fixed by hashing/verifying the bare filename
     from within the relevant directory on both sides, re-verified with an
     explicit cross-directory relocation test (backup in directory A, copy
     the pair to directory B, delete A, restore from B).
  Also added `pg_restore --exit-on-error` (not a false-green bug — `set -e`
  already fails the script on `pg_restore`'s nonzero exit — but materially
  cleaner for a destructive recovery script to stop at the first error),
  reordered `umask 077` before output-directory creation, and softened the
  checksum-mismatch wording from "corrupted or tampered with" to "corrupted
  or mismatched" since an unsigned SHA-256 file protects against accidental
  corruption, not a malicious actor able to replace both files.
- **Explicitly not the real production restore drill.** This proves the
  backup/restore/invariant-check pipeline's mechanics work; the real gate in
  `docs/DATABASE_RECOVERY.md` still requires provisioning the actual
  production Neon project and drilling against it with the full application
  schema and smoke tests, none of which a throwaway local cluster with a
  stripped-down test schema can stand in for.

## Completed (production Resend email backport — branch feat/production-resend-email-backport)

`main`'s email stack was missing several reliability fixes and the real
Resend provider that only existed on `feat/charipay-integration` — brought
over as a clean, email-only slice, deliberately without any ChariPay code:

- New: `lib/email/resendProvider.ts` (`ResendEmailProvider`, real Resend
  REST API delivery, idempotency-key forwarding, retryable-vs-permanent
  error classification), `lib/email/runtime.ts`
  (`isResendTestRecipientAllowed`), `lib/email/eagerDispatch.ts`
  (`scheduleEagerEmailDispatch`, a best-effort immediate post-request
  drain via Next.js `after()` — swallows the synchronous throw `after()`
  raises outside a real request scope, e.g. every existing test that
  calls a route handler directly, so it's always safe to call
  unconditionally), and `lib/http/internalAuth.ts`
  (`isInternalRequestAuthorized` — accepts either the existing
  `X-Internal-Secret` or Vercel Cron's own `Authorization: Bearer
  <CRON_SECRET>`, needed by the dispatch-emails route this port also
  brought over unchanged).
- Updated: `lib/email/dispatcher.ts`, `lib/email/index.ts`,
  `lib/email/notifications.ts`, `lib/email/provider.ts`, and
  `app/api/internal/dispatch-emails/route.ts` replaced wholesale with
  `feat/charipay-integration`'s versions (confirmed zero ChariPay
  references in any of them beforehand) — includes the privacy-safe
  sanitized `EmailProviderError` codes, retryable/non-retryable
  classification, and the naive-timestamp-vs-`now()` fix
  (`next_attempt_at <= (now() AT TIME ZONE 'UTC')`, not a bare `now()`).
- Hand-patched (not wholesale-copied, since the source files also carried
  unrelated ChariPay-specific changes): `scheduleEagerEmailDispatch()`
  wired into `app/api/payments/webhook/fake/route.ts` (which also picked
  up the same `now()`-vs-naive-timestamp fix for its own
  `payment_events.received_at` insert),
  `app/api/internal/sweep-expired-holds/route.ts`, and
  `app/(admin)/admin/orders/[orderId]/actions.ts`'s refund action —
  skipped porting `getPaymentProviderByName`'s multi-provider refactor
  (unneeded while `main` only has the `fake` provider) and the ChariPay
  two-phase-refund `"processing"` state branch.
- Test files replaced/added to match:
  `tests/integration/notifications.test.ts`,
  `tests/unit/email/fakeProvider.test.ts` (both had grown substantially
  on the feature branch and would otherwise assert the old unsanitized
  error-message behavior), plus the new
  `tests/integration/dispatch-emails-route.test.ts`,
  `tests/integration/emailDispatchConcurrency.test.ts`,
  `tests/unit/email/eagerDispatch.test.ts`,
  `tests/unit/email/resendProvider.test.ts`, plus
  `tests/integration/sweep-expired-holds-route.test.ts` (added for the
  auth-surface change below). Full suite: 249/249 passing,
  `tsc --noEmit`/`eslint`/`next build` all clean.
- Deliberately not ported: the CI Postgres-TimeZone regression guard in
  `tests/setup.ts` that enforces the `now()`-vs-naive-timestamp fix stays
  caught (would require also updating `.github/workflows/ci.yml`'s
  Postgres service `TZ`, which `main`'s CI doesn't currently set). Only
  the email/outbox and `payment_events.received_at` timestamp fixes are
  included by this port — **not** `lib/inventory.ts`'s identical bug
  class, which remains genuinely present on `main` (see item 10 below);
  the extra CI safety net is a smaller follow-up once that's addressed
  too.
- `sweep-expired-holds` now shares `dispatch-emails`'s
  `isInternalRequestAuthorized` (`X-Internal-Secret` or Vercel Cron's
  `Authorization: Bearer <CRON_SECRET>`) and exposes `GET` alongside
  `POST`, matching its own doc comment's claim (GPT catch — this route
  had been left on the old raw-secret-only, POST-only check while the
  ported `dispatch-emails` comment already described both routes as
  sharing the same pattern); covered by the new test file above.
- `.env.example` and `docs/ARCHITECTURE.md` updated to describe Resend/
  eager-dispatch/Cron-auth instead of the stale "console only, no real
  provider" description; `TASKS.md`'s own pre-existing self-contradiction
  (item 2 below already claimed Resend was "done" while `## Blocked`
  simultaneously listed email delivery as blocked on provider selection —
  neither was accurate on `main` until this port) corrected.
- Still needed before real customer traffic: set Production's actual
  `EMAIL_PROVIDER=resend`/`RESEND_FROM_EMAIL`/a production-scoped
  `RESEND_API_KEY` (currently `console`), redeploy, and run one real
  application-originated delivery smoke test — see item 2 below.

## Completed (naive-timestamp-vs-`now()` fix — PR #82)

`main`'s naive-timestamp-vs-`now()` bug, squash-merged as commit
`f010face`, 2026-09-23 (found by GPT auditing PR #81; three raw-SQL
comparisons — `releaseExpiredAndLock`, the per-user purchase-limit count
in `createHold`, and `sweepExpiredHolds` — compared the naive `expires_at`
timestamp column against a bare `now()`, which implicitly casts through
the session's `TimeZone` GUC before comparing, silently skewing every
hold's effective lifetime whenever Postgres isn't running with
`TimeZone=UTC`). Same bug class already fixed in `lib/email/dispatcher.ts`
and (via PR #81) the fake webhook's `payment_events.received_at` insert,
but this one affected the core oversell-prevention hold-expiry mechanism
specifically, not just email scheduling.

PR #82 fixed only the narrow `now()` → `(now() AT TIME ZONE 'UTC')`
comparison in all three spots. It deliberately did **not** port
`feat/charipay-integration`'s additional `order_id IS NULL` exclusion of
order-linked reservations from lazy release/expiry-counting — that
behavior exists there to stop a ChariPay hosted-checkout redirect from
looking "expired" locally while a real async payment is still in flight,
and is a separate behavioral hardening question, not a
timezone-correctness one.

**Correction (GPT's review of PR #82 caught a factual error in an
earlier version of this note):** this doc previously justified leaving
`order_id IS NULL` out by claiming `main`'s fake-provider checkout is
"synchronous, no redirect-then-wait window" — that is false.
`FakeProvider.createPayment()` (`lib/payments/fakeProvider.ts`) returns
`redirectUrl: /pay/fake/${paymentId}`, architecturally identical to a
real hosted-checkout redirect: the customer can sit on that page
indefinitely before clicking "simulate," exactly the same
redirect-then-wait window ChariPay has. So `main` is **not** exempt from
this race by construction; the real reasons PR #82 still left
`order_id IS NULL` out are narrower ones: `releaseHold` already refuses
to release a reservation once `orderId` is set (`CHECKOUT_IN_PROGRESS`),
and `confirmOrderPayment`'s `paid_but_unfulfillable`/
`reconciliation_required` states already exist specifically to catch
payment-success-after-reservation-expiry without allowing
double-ticketing — so the race PR #82 leaves unaddressed degrades to a
reconciliation-flagged order, not an oversold ticket. **Whether that's an
acceptable interim posture for `main`, or whether the `order_id IS NULL`
exclusion should be ported independently of ChariPay in its own PR, is
still an open question — not yet resolved.** Tracked as a follow-up in
`## Next` below.

PR #82 also ported the CI-only non-UTC TimeZone regression guard from
`feat/charipay-integration` (`.github/workflows/ci.yml`'s postgres
service `TZ: Asia/Kolkata`, `tests/setup.ts`'s CI-only assertion) so this
bug class stays caught in CI going forward, not just this once.

**The new CI guard immediately proved its worth**: it surfaced two more
instances of the exact same bug, outside `lib/inventory.ts` —
`lib/admin/catalog.ts`'s `updateEvent` (per-user committed-quantity check
before lowering `maxTicketsPerUser`) and `updateSalesPhase`
(committed-quantity check before lowering `phaseQuantityLimit`) both
compared `expires_at` against a bare `now()`. Reproduced locally against
a session TimeZone matching CI (`Asia/Kolkata`): 3 real failures in
`admin-catalog.test.ts` (limit-decrease guards silently resolving
instead of rejecting, since the implicit positive-offset cast made
already-committed active reservations look expired). Fixed in the same
PR with the identical `(now() AT TIME ZONE 'UTC')` cast; all 13
admin-catalog tests and the full 249/249 suite passed under both a UTC
and non-UTC session. Grepped the rest of `lib/` for any remaining bare
`now()`-vs-naive-timestamp comparisons — none found.
`lib/orders/checkout.ts`'s `provider_init_at` comparison was checked and
is NOT this bug: that column is written via DB-side `now()`, not a JS
`Date`, so both sides of its comparison already share the same session's
`now()` with no cross-source skew — a different issue, already fixed
separately in commit `dad10c6`.

## Completed (sync `main` into `feat/charipay-integration` — branch chore/sync-main-into-charipay)

`main` had drifted 10 commits ahead of this branch (PRs #52-58's email-
dispatch-scheduling work, PR #79's Vercel bypass-header fix, PR #81's
Resend backport, PR #82's naive-timestamp fix) since this branch was last
resynced. Merged `origin/main` into a dedicated sync branch off this
one's tip and resolved 9 conflicted files by hand rather than trusting
either side blindly:

- `lib/inventory.ts`, `lib/email/notifications.ts`,
  `app/(admin)/admin/orders/[orderId]/actions.ts`,
  `app/api/internal/sweep-expired-holds/route.ts`,
  `app/api/payments/webhook/fake/route.ts` — this branch's own versions
  were already more advanced (the `order_id IS NULL` in-flight-checkout
  exclusion, real ChariPay reconciliation calls in the housekeeping route,
  the `processing`-state refund-action branch), so kept this branch's
  content; `main`'s versions of the same fixes had already converged
  independently or were narrower subsets.
- `.env.example`, `.github/workflows/ci.yml`,
  `docs/ARCHITECTURE.md` — comment/prose-only conflicts; merged for
  accuracy rather than picking one side wholesale (e.g. `ARCHITECTURE.md`'s
  email-trigger description needed `main`'s newer GitHub Actions cron
  backstop content, since `.github/workflows/dispatch-emails-cron.yml`
  itself only existed on `main` before this merge and is a genuinely new
  file on this branch now).
- `TASKS.md` — both sides had added independent, non-overlapping
  "Completed"/"Next"/"Blocked" entries; concatenated the two "Completed"
  sections in full (no information lost), but for "Next"/"Blocked"
  specifically, `main`'s shorter list was almost entirely superseded by
  this branch's own more advanced entries for the same items (PSP
  selection, email provider, Postgres/backup provider, legal documents,
  CSV export pagination, customer phone-completion — all already done or
  much further along on this branch) — kept this branch's list and
  appended only the two genuinely new `main`-only items (the
  `actions/github-script` version-pin maintenance note, and the still-open
  question of whether `main` needs its own narrow `order_id IS NULL` port
  independent of this branch).

Verified post-merge, not assumed: `npm run typecheck`/`npx eslint .` both
clean, full suite **440/440 passing** (up from 249 pre-merge, reflecting
this branch's much larger ChariPay-specific test coverage) against the
local dev cluster's non-UTC `Africa/Casablanca` session, and `npm run
build` clean with the full merged route list (ChariPay webhook,
reconcile-payment, legal pages, customer phone endpoint all present
alongside everything from `main`).

## Completed (`actions/github-script` v9.0.0 bump — PR #84, synced via PR #86)

`.github/workflows/dispatch-emails-cron.yml`'s `actions/github-script` pin
bumped from `60a0d83…` (v7.0.1) to `3a2844b…` (v9.0.0) on `main` (PR #84),
following an independent GPT audit rather than bumping casually (this
action runs with `id-token: write`, so a supply-chain regression here is
high-stakes). Audit found: the workflow only calls
`core.getIDToken()`/`setSecret()`/`setOutput()`, never Octokit or
`@actions/github`, so v9's Octokit-related breaking changes don't apply;
v7.0.1 and v9.0.0 lock the exact same `@actions/core` 1.10.1 tarball (same
npm integrity hash), so the OIDC code path itself is byte-identical
between versions; the runner (2.337.0) exceeds v8+'s minimum (2.327.1);
and the upstream repo's own `check-dist` step rebuilds `dist/` from
source and fails the bundle if it doesn't match — this audit read the
source/locked dependencies but did not independently byte-diff the full
built v9 bundle itself. Resolves the Node 20 deprecation warning the
pinned v7.0.1 was emitting.

**Runtime verification completed (2026-09-23):** GPT triggered a real
`workflow_dispatch` run against `main` on the merged SHA (run
`35903586420`), confirming the bumped action still mints the OIDC token,
passes Vercel's Trusted Sources check, and the dispatcher responds with
real JSON: `{"claimed":0,"sent":0,"retried":0,"permanentlyFailed":0,
"skipped":0}` (zero across the board reflects no email backlog at that
moment, not a failure — the call completing end-to-end with a valid
typed response is the actual proof). This closes the item; no further
action needed unless the pin is bumped again in the future, which should
get its own fresh audit rather than reusing this one.

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
   against the real provider.

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
   `payment.failed` path is documented to fire for).

   **Update, later investigation:** no documented self-service way exists in
   ChariPay's sandbox to force a genuine `payment.failed` (no wrong-3DS or
   abandoned-challenge procedure is published) — this acceptance item is
   blocked pending a provider-supported sandbox procedure, which needs a
   direct ChariPay support contact (`info@charipay.ma` / `+212 632 646
   464`), not another local attempt.

   The refund half of this item is separately blocked: `POST /v1/refunds`
   is accepted at the HTTP layer (`202`) but returns a synchronous
   body-level `FAILED` result whose `failureMessage` reports a downstream
   Chari `403` for missing `operations:refund`. The active merchant key
   already has the portal-exposed `refund:create` and `refund:read`
   permissions, and the complete editable portal list has no
   `operations:refund` option. This is therefore a provider-side sandbox
   enablement/support issue, not a self-service key edit. Escalate the exact
   error plus correlation id `46965bf5-7d91-4655-9e71-7d909e5a11b0` to
   ChariPay support; do not rotate/broaden the key speculatively
   (see `docs/CHARIPAY.md`).
2. **Delivery pipeline now proven end-to-end on Preview (2026-09-19/20);
   production sending domain verified on 2026-09-22.** The full
   EmailOutbox → dispatcher → Resend chain was exercised with a real paid
   order and confirmed delivered/idempotent. #48 is closed: the scheduled
   `dispatch-emails` trigger has real observed scheduled runs and is now a
   working backstop (GitHub's `schedule` trigger has no 5-minute recovery
   guarantee, so the eager `after()` dispatch remains the primary path —
   see the "eager email dispatch trigger" entry above). Resend now reports
   `mail.medinabelgique.com` verified after Cloudflare DNS setup; the
   intended temporary sender is
   `tickets@mail.medinabelgique.com` (the adapter adds the `OnlyLive` display name itself). This domain is for
   pre-production/testing and can be replaced later with the final OnlyLive
   domain without a code change. What remains for production runtime is to
   configure/verify `EMAIL_PROVIDER=resend`, `RESEND_FROM_EMAIL`, and a
   production-scoped `RESEND_API_KEY` in Vercel, with no
   `RESEND_TEST_RECIPIENT` override in Production, then redeploy and send
   a real application-originated smoke email.
3. **Production database recovery — scripts now exist and are locally
   proven; production provisioning drill still open.** Neon is the selected
   production Postgres target and `docs/DATABASE_RECOVERY.md` defines
   separate production provisioning, a >=7-day PITR target, daily
   independent logical backups, RPO/RTO targets, and a mandatory restore
   drill. `scripts/backup-database.sh` and `scripts/restore-drill.sh` (#69,
   merged 2026-09-22 after an independent GPT audit found and fixed four
   real issues across two review passes: non-executable git mode, a
   checksum check that warned instead of failing closed, `pg_restore
   --clean` not guaranteeing a pristine target, and a checksum that hashed
   the dump's full path instead of a portable bare filename) now implement
   this exactly, gated by `RESTORE_DRILL_CONFIRM=yes`,
   `RESTORE_DRILL_TARGET_IS_FRESH=yes`, and fail-closed checksum
   verification. Run end-to-end against a real throwaway local Postgres
   cluster, including a cross-directory relocation test (backup in one
   directory, copy to another, delete the original, restore from the copy).
   A read-only `scripts/recovery-smoke.sql` validates core inventory/ticket/
   payment invariants after restore; CI executes it on a freshly migrated
   empty test database to catch schema/SQL drift, and `.gitignore` blocks
   common dump artifacts.
   **Update, 2026-09-23 — the real production Neon project now exists and
   Vercel Production is live and functional.** Created `onlylive-production`
   (Neon project id `delicate-flower-79359696`), region `aws-us-east-1` —
   deliberately not the sandbox's `aws-us-east-2`, chosen by actually reading
   a real Vercel build log's region (`iad1`, Washington D.C.) rather than
   copying the sandbox by assumption, per this file's own long-standing
   instruction above. Ran `prisma migrate deploy` against it for real (9
   migrations applied cleanly) and `scripts/recovery-smoke.sql` for real (0
   violations on every invariant). `DATABASE_URL` (Neon's pooled connection —
   confirmed locally that `prisma migrate deploy` works through Neon's
   pooler without issue, so a single connection string safely covers both
   migrations and runtime here) is now set in Vercel Production.

   Getting an actual successful Production deployment exposed a real,
   pre-existing gap: **every Production environment variable this project
   had ever documented was still an empty, never-filled Vercel scaffold
   placeholder** (`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `ADMIN_SESSION_SECRET`,
   `PAYMENT_PROVIDER`, `RATE_LIMIT_KEY_SECRET`, `INTERNAL_API_SECRET`,
   `FAKE_PSP_WEBHOOK_SECRET`, `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION` — Production
   had literally never been deployed successfully before). Fixed, with
   GPT's explicit sign-off sought before touching anything security-relevant:
   - the five random secrets: generated fresh (`openssl rand -base64 32`,
     distinct from Preview's values, never pasted into chat/logs/Git);
   - `NEXTAUTH_URL`: the user confirmed the default Vercel URL
     (`https://onlylive-events-el-bied-alis-projects.vercel.app`) since no
     custom domain is connected yet;
   - `PAYMENT_PROVIDER=fake` + `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true`:
     GPT's sign-off was explicitly conditional on this Production deployment
     being access-protected with no real customer traffic — confirmed via
     Vercel's own project settings (`ssoProtection.enabled: true,
     deploymentType: "all_except_custom_domains"`) that the default
     `.vercel.app` URL genuinely requires Vercel team SSO to reach; **this
     must be revisited (remove the fake-payment override, add real ChariPay
     credentials) before any real customer traffic.**

   A green Vercel "READY" status then turned out to be insufficient by
   itself: querying Vercel's own runtime-error aggregation caught a real
   crash — `Unknown EMAIL_PROVIDER: resend. Only "console" is implemented so
   far.` Root cause, confirmed by reading the actual deployed code: **this
   Vercel Production deployment builds from `main`, not
   `feat/charipay-integration`** — `main`'s `lib/email/index.ts` genuinely
   only implements `ConsoleEmailProvider`; every Resend/ChariPay adapter
   lives exclusively on `feat/charipay-integration`, matching this project's
   own branch strategy (ChariPay/Resend stay draft-gated pending the
   independent audit below and KYB approval, and must not reach `main`
   before that). Setting `EMAIL_PROVIDER=resend` in Production was therefore
   a mistake — corrected to `EMAIL_PROVIDER=console` +
   `ALLOW_CONSOLE_EMAIL_IN_PRODUCTION=true`, the exact non-production-traffic
   allowance already coded for this. Re-verified: deployment `READY`, and the
   user independently confirmed the real homepage renders correctly through
   the SSO wall.

   **Correction, 2026-09-23 (GPT catch on PR #77):** the original "zero
   runtime errors afterward" claim above was inaccurate — Vercel's own
   runtime-error aggregation still showed a real
   `SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are
   treated as aliases for 'verify-full'` warning from the `pg` driver,
   because `main`'s `lib/db.ts` lacks the code-level `sslmode` normalization
   that only exists on `feat/charipay-integration` (PR #76). Fixed by setting
   `sslmode=verify-full` explicitly in the `DATABASE_URL` connection string
   itself (Vercel env var, not code) and triggering a fresh redeploy.
   Verified by ordering, not assumption: the `DATABASE_URL` edit timestamp
   (`1790123522448`) precedes the current live Production deployment's
   creation (`dpl_DQ6x7KW8tcNARMaB1xSUy4peMnXg`, created `1790129513633`,
   `READY`, aliased to production) — so that deployment's Lambda runtime
   only ever read the corrected connection string. Re-querying
   `get_runtime_errors` confirms zero errors of any kind (including the SSL
   warning) attributed to `dpl_DQ6x7KW8tcNARMaB1xSUy4peMnXg` specifically;
   the SSL warning remains visible in Vercel's history but only against the
   prior deployment (`dpl_9hYPRgAXBYGCrQXKmCqKkJfmKxw2`), which predates the
   fix. A direct authenticated request against the SSO-protected alias was
   not exercised as part of this check.
   `RESEND_API_KEY`/`RESEND_FROM_EMAIL` were left set in Production during
   this pass but are dormant — `main` cannot read them — and per GPT's
   review should be removed for now (an unused live secret is unnecessary
   exposure, and leaving it risks a future branch-merge/config mistake
   silently activating real email instead of failing loudly); re-add both,
   deliberately, only once `feat/charipay-integration` actually reaches
   `main`.

   **This still is not the real production restore drill this gate
   requires.** Still needed before go-live: configure paid recovery
   retention (current project is on Neon's free tier — 6-hour PITR window,
   not the >=7-day target) + independent backup storage, then perform a
   timed recovery drill using a real production backup/PITR recovery into a
   disposable, isolated restore target (never the live production database
   itself), followed by the invariant check and the application smoke
   tests below.
   Do not infer the current Vercel Preview database from the connected Neon
   project named for the sandbox: read-only inspection on 2026-09-19 found
   that project contains no application tables.

   **Also clarified, 2026-09-23:** CLAUDE.md's "triage an independent
   audit" gate for ChariPay/PR #13 does not name who performs it. The user
   explicitly confirmed the Claude/GPT cross-audit pattern already used
   throughout this project (every substantive PR reviewed by whichever of
   the two didn't write it, before merge — see this file's own history) is
   sufficient for PR #13 too, rather than requiring a separate external or
   professional security review. (Attempted to record this directly in
   CLAUDE.md; blocked by this environment's own guard against an agent
   editing its own instructions file — recorded here instead.)
4. **Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
   structural placeholders now published, real legal review still required.**
   Added four draft pages (`/legal/mentions-legales`,
   `/legal/conditions-generales`, `/legal/politique-de-confidentialite`,
   `/legal/politique-de-remboursement`), linked from the homepage footer,
   each carrying a visible "brouillon — ne pas utiliser en production"
   banner and explicit `[À COMPLÉTER]` markers on every clause requiring a
   legal/accounting decision this project must not invent (governing law,
   company registration numbers, CNDP declaration, data-retention periods,
   withdrawal-right applicability, refund-fee allocation). The factual
   parts these pages do state (what personal data is actually collected —
   email, optional name/phone, order/ticket history; that OnlyLive never
   receives card PAN/CVV because ChariPay's hosted checkout handles
   payment; that refunds are admin-initiated and only take effect once
   ChariPay confirms success) were checked directly against
   `prisma/schema.prisma` and `docs/CHARIPAY.md`, not invented. Still
   requires OnlyLive's accountant/lawyer to complete every `[À COMPLÉTER]`
   and formally approve before removing the draft banner and treating
   these as real, binding legal documents.

   **Update — GPT's audit of PR #71 found and fixed four further real
   issues before merge:** (1) the refund policy's "vente ferme et
   définitive" sentence decided a real legal/commercial policy itself
   instead of leaving it to counsel — now a placeholder; (2) the CGV's
   checkout-expiry description contradicted `lib/orders/checkout.ts`'s
   actual behavior (inventory stays reserved past local expiry until
   provider reconciliation proves it safe to release, not released
   immediately) — corrected to match; (3) the privacy policy claimed an
   exhaustive ("uniquement") data list while omitting technical/security
   processing already in the app (IP-based rate limiting, session data,
   payment-event records, audit logs) — changed to "notamment" plus an
   explicit technical/security category, and "nous ne vendons pas vos
   données" (an unverifiable business-policy claim) became a placeholder
   too; (4) most importantly, a real deployment-safety gap: the pages said
   "ne pas utiliser en production" while the homepage linked them
   unconditionally, with nothing stopping the branch from eventually
   reaching production with unfinished placeholders publicly live. Added
   `lib/legal/approval.ts`'s `legalDocumentsApproved()` gate (`notFound()`
   on all four pages plus the homepage footer links, unless
   `LEGAL_DOCUMENTS_APPROVED=true` is explicitly set outside
   non-production) and `robots: noindex` on all four, matching this
   project's existing `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION`-style pattern for
   a dangerous default. Covered by a new
   `tests/unit/legal/approval.test.ts` (the gate logic itself, matching
   how the sibling fake-payment gate is tested) plus
   `playwright.config.ts` explicitly opting the e2e server into
   `LEGAL_DOCUMENTS_APPROVED=true` — discovered while wiring this up that
   `next start` always runs `NODE_ENV=production`, so e2e needs the same
   explicit opt-in as the other production guards, not something the
   original PR's test comment had accounted for.
5. Stage Vercel WAF rate-limit rules in log mode before production, observe
   real traffic, then tune/enforce without replacing account-level limiting.
6. Before production rollout, smoke-test admin login/logout, catalogue
   mutation and scanner validation on the real Vercel preview/custom domain.
   **Update, 2026-09-23:** now actually attemptable — Vercel Production was
   previously never in a working state at all (see item 3's update above).

   **Correction, 2026-09-23 (GPT catch on PR #77):** the original plan here
   ("seed an admin account") implicitly meant running `npm run seed`, which
   is unsafe against a real production database — `prisma/seed.ts`
   unconditionally creates the full demo catalogue (the real Tiakola/
   Casablanca venue, event marked `on_sale`, three ticket categories,
   inventory, two sales phases each) regardless of whether admin credentials
   are supplied, which would create a real-looking on-sale event in
   `onlylive-production`. Fixed by adding `prisma/bootstrap-admin.ts`
   (`npm run bootstrap-admin`), a narrowly-scoped script that upserts
   exactly one `super_admin` `AdminUser` row from `ADMIN_SEED_EMAIL`/
   `ADMIN_SEED_PASSWORD` and touches nothing else — verified locally against
   a throwaway Postgres cluster (admin_users count 1→2; events/venues/
   ticket_categories/inventory/sales_phases counts unchanged at
   1/1/3/3/6). `docs/SECURITY.md`'s admin-bootstrap section now documents
   the split: `npm run seed` for fresh dev/demo databases only, `npm run
   bootstrap-admin` for any existing/production database.

   **Update, 2026-09-23 — smoke test actually run against real Production.**
   `npm run bootstrap-admin` run for real against `onlylive-production`
   (verified via read-only query: exactly one active `super_admin`,
   `ali.el.bied9898@gmail.com`; catalogue tables still all zero
   immediately before/after). Admin login/logout: **passed** — real
   dashboard renders, correct empty-state counts. Catalogue mutation:
   **passed** — created a clearly-labeled `SMOKE TEST` venue, event
   (`draft`, then `on_sale`), ticket category (capacity 5) and an active
   sales phase (100 MAD) through the real admin UI; each step verified via
   a read-only Neon query, not just the UI. Customer checkout/hold:
   **passed** — reservation created with the expected 15-minute expiry
   countdown.

   **Payment confirmation: failed, and found a real production-readiness
   gap, not a test-setup mistake.** Clicking "Simuler un paiement réussi"
   on `/pay/fake/[paymentId]` returns a 401 every time. Root-caused by
   inspecting the actual response shape (not just the status code): the
   outer `POST /api/pay/fake/[paymentId]/simulate` route runs
   successfully to completion (session, payment ownership, and signature
   generation all fine) and reaches its final step, an internal
   server-to-server `fetch()` call to this same deployment's own public
   URL at `/api/payments/webhook/fake`. That inner call is the one
   receiving the 401 — confirmed via Vercel's `get_runtime_logs`, which
   shows **zero invocations of the webhook route** across multiple
   attempts, meaning the request never reached our Next.js code at all.
   **Correction (GPT catch):** the fake and real ChariPay webhooks are
   different routes (`/webhook/fake` vs `/webhook/charipay`), not the same
   application code path — what they share, and what's actually the
   problem, is the same Vercel ingress + Deployment Protection layer
   sitting in front of both.

   The cause: this Vercel project has `ssoProtection.enabled: true` with
   `deploymentType: "all_except_custom_domains"`, and **no custom domain
   is connected yet** — so every current URL, including this internal
   self-call, is behind the Vercel SSO wall. Vercel's own protection layer
   is intercepting the request before Next.js ever sees it.

   **This is a real production-launch blocker, not just a test artifact:**
   once ChariPay is live, its real webhook deliveries will hit a
   `.vercel.app`-hosted URL from outside Vercel's network with no SSO
   session, and would be blocked identically today. **Correction (GPT
   catch):** the original claim that ChariPay has "no way" to send a
   Vercel bypass header was wrong — ChariPay's webhook config supports
   static custom headers (its documented restrictions only forbid
   overriding `Host`, `Authorization`, `Cookie`, `Chari-*`, `X-CHARI-*`),
   so `x-vercel-protection-bypass` is a real provider-side option, and
   Vercel also documents a query-parameter form of the same bypass for
   providers that can't set custom headers at all. Launch must still not
   happen against an SSO-protected `.vercel.app` URL, but the fix is a
   choice, not a hard blocker with only one option: (a) connect a real
   custom domain before go-live — Vercel's own `deploymentType` setting
   already exempts custom domains from SSO protection, so this is the
   normal, recommended path (preview URLs stay protected, the production
   domain is public, webhook security then rests on ChariPay's signature/
   payload validation and app rate limits, not Vercel SSO); or (b)
   configure Vercel's "Protection Bypass for Automation" and register that
   header in ChariPay's webhook config — technically workable per the
   above, but couples the PSP to a Vercel-specific secret that must be
   stored/rotated/kept in sync on ChariPay's side, so it's a reasonable
   fallback/test aid, not the final architecture.

   **Smoke-test unblock (GPT's recommendation):** don't rewrite the
   simulate route to process the webhook in-process — that would remove
   exactly the part of the test worth having (the real HTTP call through
   the real webhook route). Instead, enable Vercel's Protection Bypass for
   Automation for this project and have the simulate route's internal
   `fetch()` send `x-vercel-protection-bypass` from
   `VERCEL_AUTOMATION_BYPASS_SECRET` when that env var is set, preserving
   the full path (simulate route → real HTTP call → webhook route →
   signature check → DB transaction → ticket). Before real customer
   traffic: connect the real custom domain, register ChariPay's webhook
   against it (e.g. `<domain>/api/payments/webhook/charipay`), run one
   real synthetic ChariPay webhook end-to-end against that domain and
   confirm a real `2xx`, and keep the `.vercel.app` URLs protected
   permanently.

   **Update, 2026-09-23 — implemented (PR #79, merged to `main`) and the
   full smoke test now passes end-to-end against real Production.**
   `app/api/pay/fake/[paymentId]/simulate/route.ts` sends the bypass
   header (via `lib/payments/fakeWebhookForwarding.ts`, kept out of the
   Route Handler file itself as a precaution per a second GPT review —
   Next.js's documented convention is that `route.ts` only exports HTTP
   methods and segment config, though this project's own local `next
   build` (Turbopack, Next 16.3.5) had actually succeeded either way,
   with the extra export present and un-warned-about; moving it out
   removes the risk on a payment file regardless of whether it would
   have failed) and resolves the
   self-call target from `NEXTAUTH_URL` (`lib/appUrl.ts`'s
   `absoluteAppUrl()`), not `request.url`, since a real secret is now
   attached to that request. The Protection Bypass for Automation secret
   turned out to already exist on this project (added 2026-09-14, visible
   as a "System Environment Variable" in the dashboard's Deployment
   Protection settings — it does not appear in the project-envs API
   listing this session otherwise relied on, since system env vars are a
   distinct category). Vercel auto-deployed `main` on the PR #79 merge
   (`dpl_8tujtYmsCZXsXcP3wAf9nFAaNtTU`); `get_runtime_errors` showed zero
   errors afterward.

   Re-ran "Simuler un paiement réussi" on the same held reservation from
   the earlier attempt: **succeeded**, redirected to the real order page.
   Verified via a read-only Neon query, not just the redirect: `orders`
   row `status = paid`, its `payments` row `status = paid`, and a real
   `tickets` row (`status = valid`) with a generated validation token.
   Scanner test: logged into `/scanner` with the existing admin session
   (`super_admin` is an allowed scanner role per `lib/auth/admin.ts`),
   manually entered the ticket's validation token — **first scan: green
   "Entrée acceptée"; immediate re-scan of the same token: orange "Déjà
   scanné"**, both recorded with timestamps in the scan history panel.
   This is the full admin/catalogue/checkout/payment/ticket/scanner
   smoke test item 6 has tracked, now passing end-to-end against the
   real `onlylive-production` deployment. Scanner-side concurrent-scan
   atomicity (two scanners racing the same ticket) was not separately
   re-verified here — already covered by this project's existing
   automated test suite, not something this manual smoke test needed to
   repeat.

## Blocked

- ChariPay sandbox API key, webhook signing secret, and public HTTPS
  preview URL are obtained and end-to-end payment.succeeded validation is
  done (see "In progress" above and docs/CHARIPAY.md's checklist) — no
  longer blocking. **Update, 2026-09-22 — both remaining captures turned out
  to need more than sandbox exercises alone, not less:**
  - `payment.failed`: the sandbox has exactly one valid test card and no
    documented way to force a decline, cancel a session without firing any
    webhook, or synthesize anything but a fake `payment.succeeded` via the
    test-event endpoint. Genuinely blocked on ChariPay's own guidance —
    the next step is asking their integrator contact
    (info@charipay.ma / +212 632 646 464) for a supported sandbox
    procedure, not more app-side attempts.
  - Refund success/failure: two real code bugs were found and fixed via
    real sandbox attempts (`operationId` vs `externalId`; `reason` closed
    enum vs free text — see `docs/CHARIPAY.md`'s Refund lifecycle
    section for both). With those fixed, the next real attempt exposed
    the actual current blocker: the provider returns downstream
    `403 Forbidden` / `BAAS_CHARI_ERROR` for missing
    `operations:refund`. The active sandbox key already has
    `refund:create` and `refund:read`, while the portal exposes no
    editable `operations:refund` permission. This now requires ChariPay
    support/provider-side sandbox enablement, using correlation id
    `46965bf5-7d91-4655-9e71-7d909e5a11b0`; do not rotate or broaden the
    key speculatively.
  Real production go-live additionally requires OnlyLive merchant/KYB
  approval and live credentials; no production secret should be committed
  or pasted here.
- Real email delivery is no longer blocked at the pipeline or domain-verification level — proven end-to-end on Preview 2026-09-19/20, and `mail.medinabelgique.com` was verified by Resend on 2026-09-22. Production delivery still needs the Vercel Production variables (`EMAIL_PROVIDER=resend`, `RESEND_FROM_EMAIL=tickets@mail.medinabelgique.com`, and a production-scoped `RESEND_API_KEY`) plus a redeploy/smoke send. Do not set `RESEND_TEST_RECIPIENT` in Production. The scheduler gap is already closed by the working GitHub Actions backstop; eager dispatch remains primary.
- Legal document drafting is blocked on legal/accountant review and ChariPay's
  final merchant/go-live requirements.

## Next (this branch, continued)

7. **`main`-specific, resolved by not porting on this side of the sync:**
   whether `main` (independently of this branch's full ChariPay merge)
   should get a narrower version of this branch's `order_id IS NULL`
   in-flight-checkout exclusion in `lib/inventory.ts`. This branch's own
   `lib/inventory.ts` already has it (kept as-is by this sync — see the
   merge-conflict resolution above). The open question was specifically
   about `main`'s posture until PR #13 lands there: `main`'s fake-provider
   checkout has the identical redirect-then-wait shape as a real hosted
   checkout, so it isn't exempt from the race by construction, but
   `paid_but_unfulfillable`/`reconciliation_required` already degrade it to
   a flagged order rather than an oversold ticket. Whether that's an
   acceptable interim posture for `main` pending PR #13, or worth its own
   narrow follow-up PR, is still open — not yet discussed with GPT.

## Deferred (explicitly out of scope, per CLAUDE.md)

- Offline scanning / multi-device offline reconciliation.
- General background-worker infrastructure beyond the current sweep endpoint
  and the targeted retry/alert jobs explicitly added to `Next` above.
