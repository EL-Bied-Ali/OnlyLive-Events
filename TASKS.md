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

## Completed (transactional email)

- Swappable email-provider interface with a console-only sandbox provider.
- Idempotent order-confirmation, payment-failure and refund-confirmation
  triggers using `EmailLog` uniqueness.
- Notifications run after the business transaction commits; email failure
  never rolls back money/ticket state.
- Known durability gap: the current `EmailLog` claim-before-send flow prevents
  duplicates but is not crash-safe exactly-once delivery. Durable outbox/retry
  work is tracked separately in PR #17 and must land before production email
  delivery is considered reliable.

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

## In progress

- **ChariPay real PSP integration — draft PR #13**, stacked on PR #11 so
  Claude can audit #11 independently. The adapter is derived from ChariPay's
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
- **Not production-ready yet:** the exact signed webhook JSON mapping still
  needs to be pinned against a real sandbox delivery (the public docs expose
  the signing contract and delivery log, but say the exact signed body is read
  from an emitted event). PR #13 stays draft until sandbox validation and the
  final independent audit are complete.

## Next

1. Validate PR #13 against a real ChariPay sandbox account: create the
   webhook endpoint, send a synthetic event, perform one successful/failed
   hosted checkout and one refund, then pin the exact webhook payload fixtures.
2. Finish/review the durable email-outbox work tracked in PR #17, then select
   a real provider (Resend/Postmark/SES/...) and implement its adapter from
   official docs.
3. Decide the production managed-Postgres provider and document/test the
   backup/restore strategy required by `CLAUDE.md`.
4. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
   requires OnlyLive's accountant/lawyer and the eventual PSP requirements.
5. Paginate the orders CSV export beyond its current most-recent-20,000 cap.
6. Add an automatic trigger/alert path for
   `paid_but_unfulfillable`/`reconciliation_required` orders rather than
   relying only on dashboard attention metrics.
7. Stage Vercel WAF rate-limit rules in log mode before production, observe
   real traffic, then tune/enforce without replacing account-level limiting.
8. Before production rollout, smoke-test admin login/logout, catalogue
   mutation and scanner validation on the real Vercel preview/custom domain.

## Blocked

- ChariPay sandbox end-to-end validation is blocked on a sandbox API key,
  webhook signing secret and a deliberate public HTTPS test/preview URL. Real
  production go-live additionally requires OnlyLive merchant/KYB approval and
  live credentials; no production secret should be committed or pasted here.
- Real email delivery is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review and ChariPay's
  final merchant/go-live requirements.

## Deferred (explicitly out of scope, per CLAUDE.md)

- Offline scanning / multi-device offline reconciliation.
- General background-worker infrastructure beyond the current sweep endpoint
  and the targeted retry/alert jobs explicitly added to `Next` above.
