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
safe machine code before a real provider is wired in. Native Vercel Cron
needs `vercel.json` + `CRON_SECRET`, not this route's custom header
contract — an external scheduler works today but must actually be
provisioned before dispatch can be relied on to run. The HTTP-loopback
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

- None.

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

## Next

1. Select a Moroccan PSP and implement its real `PaymentProvider` adapter
   from official docs (never speculatively). Re-derive contradictory-event
   reconciliation from that provider's real lifecycle and revisit holding a
   database row lock across the real network refund call.
2. ~~Select a real email provider~~ — done: Resend is selected and
   integrated (`lib/email/resendProvider.ts`, PR #81 — ported from
   `feat/charipay-integration`, where it was already implemented,
   audited, and verified end-to-end via a real unattended purchase on
   Preview). This wording was previously inaccurate on `main`: the
   integration existed only on the feature branch until this port, while
   this file simultaneously (and self-contradictorily) also listed real
   email delivery as "Blocked" below — both corrected together. Remaining
   gap here specifically: Production's actual env vars still need
   `EMAIL_PROVIDER=resend`/`RESEND_FROM_EMAIL`/a production-scoped
   `RESEND_API_KEY` set (currently `console`, since `main` couldn't
   support `resend` before this port) and one real post-deploy delivery
   smoke test — the code path itself is now ready either way.
3. Decide the production managed-Postgres provider and document/test the
   backup/restore strategy required by `CLAUDE.md`.
4. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
   requires OnlyLive's accountant/lawyer and the eventual PSP requirements.
5. Paginate the orders CSV export beyond its current most-recent-20,000 cap.
6. Stage Vercel WAF rate-limit rules in log mode before production, observe
   real traffic, then tune/enforce without replacing account-level limiting.
7. Before production rollout, smoke-test admin login/logout, catalogue
   mutation and scanner validation on the real Vercel preview/custom domain.
8. Before ChariPay go-live: a customer who registered before phone became
   required (PR #18) has `phone: null` and cannot pay — ChariPay's adapter
   rejects cleanly (`PAYMENT_CUSTOMER_DETAILS_REQUIRED`), no crash/financial
   risk, but there's currently no profile page or endpoint letting an
   existing customer add a phone number. Needs a small "complete your
   phone" flow, ideally surfaced at the start of checkout. Not a blocker if
   production has no real historical customers yet by go-live.
9. Low-priority maintenance (flagged by GPT's final #48 review, 2026-09-22):
   `.github/workflows/dispatch-emails-cron.yml` pins `actions/github-script`
   to `60a0d83…` (v7.0.1, the exact commit GPT's original audit vetted).
   GitHub Actions now emits a Node.js 20 deprecation warning for it (forced
   onto Node 24 at runtime) — it still works today, including OIDC token
   generation, but the current released version is v9.0.0. Since this
   action runs with `id-token: write`, don't bump it casually; audit a
   newer immutable SHA against the same OIDC-minting usage before updating.
10. Decide whether `feat/charipay-integration`'s `order_id IS NULL`
    in-flight-checkout exclusion (excluding order-linked reservations from
    lazy release/expiry-counting, so a real hosted-checkout redirect can't
    have its stock resold while payment is still in flight) should be
    ported to `main` independently of ChariPay, or left as ChariPay-specific
    hardening. See the PR #82 note above — `main`'s fake-provider checkout
    has the identical redirect-then-wait shape, so it is not exempt from
    this race by construction; the interim mitigation
    (`paid_but_unfulfillable`/`reconciliation_required`) degrades the race
    to a flagged order rather than an oversold ticket, but whether that's
    an acceptable permanent posture (vs. actually closing the race) is
    still open. Not yet discussed with GPT.

## Blocked

- Real PSP integration is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review and the
  eventual PSP's requirements.

## Deferred (explicitly out of scope, per CLAUDE.md)

- Offline scanning / multi-device offline reconciliation.
- General background-worker infrastructure beyond the current sweep endpoint
  and the targeted retry/alert jobs explicitly added to `Next` above.
