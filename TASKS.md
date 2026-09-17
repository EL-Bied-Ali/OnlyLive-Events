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
  (ticket links), requiring HTTPS in production except for local-loopback
  hosts (exempted for the Playwright/CI `next start` run).
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
`errorCode()`'s stored/logged error message isn't guaranteed free of
provider-specific sensitive data — needs a typed provider error with a
safe machine code before a real provider is wired in. `/api/internal/
dispatch-emails` now accepts `CRON_SECRET`/`Authorization: Bearer` the
same way `/api/internal/sweep-expired-holds` does (`lib/http/
internalAuth.ts`, shared by both routes; fixed during the PR #13 merge
audit), but it is still **not** in `vercel.json`'s `crons` array: the
current Vercel Hobby plan only allows a cron to run once per day, far too
infrequent for customer-facing order-confirmation/failure emails. An
external higher-frequency scheduler (or a paid Vercel plan, once
budgeted) must call this route directly — not provisioned yet, so
dispatch cannot be relied on to run promptly until it is. The HTTP-loopback
exemption in `lib/appUrl.ts` (`NODE_ENV=production` still permits `http://`
when the hostname is `localhost`/`127.0.0.1`/`::1`, for the Playwright/CI
`next start` run) would also silently accept a genuine production
deployment accidentally misconfigured with a loopback `NEXTAUTH_URL` —
low-impact (broken email links, not a public HTTP origin) but should gain
an explicit e2e-only override rather than relying on the hostname alone
before going further.

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
- `PATCH /api/customers/phone` (`requireCustomer`-gated) lets the
  signed-in customer set/change their own phone number; writes a
  `customer.phone_updated` audit entry, same pattern as registration's
  `customer.registered`.
- The checkout page (`CheckoutClient.tsx`) never gates on phone
  speculatively — it only shows the inline phone form after the provider
  itself returns `PAYMENT_CUSTOMER_DETAILS_REQUIRED` from
  `POST /api/checkout/[holdId]/start`, so a provider that doesn't need a
  phone (FakeProvider) is never blocked by this. Submitting the form saves
  the phone then immediately retries checkout.

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

## Next

1. Finish validating PR #13 against the real ChariPay sandbox account: the
   webhook endpoint is registered, a synthetic event was captured, and a
   real successful hosted checkout's `payment.succeeded` webhook is now
   captured and pinned (see above). Still needed: a real payment failure,
   a real refund success/failure (full and partial) with its webhook
   payload pinned, and a webhook-delivery/`refundReference` replay test
   against the real provider.
2. Select a real email provider (Resend/Postmark/SES/...) and implement its
   `EmailProvider` adapter from official docs — the durable outbox/dispatcher
   (batching, retry with backoff, idempotency key) already merged via PR #17
   and need no change to accept it; only `lib/email/index.ts`'s
   `getEmailProvider()` factory gains a new case.
3. Decide the production managed-Postgres provider and document/test the
   backup/restore strategy required by `CLAUDE.md`.
4. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
   requires OnlyLive's accountant/lawyer and the eventual PSP requirements.
5. Paginate the orders CSV export beyond its current most-recent-20,000 cap.
6. Stage Vercel WAF rate-limit rules in log mode before production, observe
   real traffic, then tune/enforce without replacing account-level limiting.
7. Before production rollout, smoke-test admin login/logout, catalogue
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
- Real email delivery is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review and ChariPay's
  final merchant/go-live requirements.

## Deferred (explicitly out of scope, per CLAUDE.md)

- Offline scanning / multi-device offline reconciliation.
- General background-worker infrastructure beyond the current sweep endpoint
  and the targeted retry/alert jobs explicitly added to `Next` above.
