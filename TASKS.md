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
- Test suite: 88 Vitest unit/integration tests + 10 Playwright e2e tests,
  all passing (`npm test`, `npm run test:e2e`). See tests.json for the
  full mandated-scenario checklist and what's covered vs. still pending.
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
   and a per-user/event purchase cap (`MAX_TICKETS_PER_USER_PER_EVENT`,
   via a `pg_advisory_xact_lock` so it holds across categories) — none
   of it from a pre-transaction read.
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
   atomic re-fulfillment from current stock, landing on `paid` (new
   `OrderStatus`) if possible or the new `reconciliation_required` status
   (human-resolved, audit-logged) if not. `Payment.status` is set to
   `paid` either way — money captured is never hidden. Documented as a
   stopgap pending the real PSP's official event-lifecycle docs (see
   docs/PAYMENTS.md's Reconciliation section) — this is explicitly not
   assumed to be the final policy.
2. **Concurrent provider initialization** — `startCheckout` prevented
   duplicate database Orders but not duplicate *provider calls*:
   concurrent callers could all see `redirectUrl: null` and all call
   `provider.createPayment` at once. Added a durable claim
   (`payments.provider_init_at`, guarded `UPDATE`) so only one caller
   calls the provider; others poll briefly instead. A stale claim (crash/
   timeout) can be reclaimed after a timeout window. The stable
   `idempotencyKey` is preserved across claims/retries.
3. **Expired retry after provider failure** — a retry could still start a
   brand-new provider payment for a reservation that had since expired
   and been swept, if the first provider call had failed. Added an
   expiry check (direct `expires_at` comparison, not dependent on the
   sweep) before allowing a *new* provider-initialization attempt; an
   already-completed initialization's stored redirect is still returned
   regardless of expiry.
4. **Expired holds inflated the purchase-limit count** — the per-user/
   event total counted `active` reservations that were expired in fact
   (`expires_at` in the past) but not yet flipped by the sweep, wrongly
   consuming a customer's allowance. The count now excludes them directly
   in its `WHERE` clause, without depending on the sweep.
5. **Webhook reclaim consistency** — reprocessing an interrupted
   (`processedAt = null`) `payment_events` row didn't verify it still
   matched the current request's resolved payment, event type, or prior
   signature validity. Added a consistency check
   (`isConsistentWithExistingClaim`); any mismatch is rejected
   (`409 EVENT_COLLISION`) and audited rather than reprocessed, and the
   original row's `rawPayload`/`signatureValid` are never overwritten.
6. **Accidental `Hello-html` doc links** — checked; none exist in this
   repository. Rejected as not applicable.

New regression tests (all passing): reconciliation (failed→succeeded
while fulfillable, after resale, cancelled→succeeded, audit records),
concurrent-checkout asserting `provider.createPayment` is called exactly
once, expired-retry-after-provider-failure (swept and lazy/unswept),
expired-hold purchase-limit exclusion (same category and cross-category),
and webhook reclaim collisions (invalid-signature upgrade attempt,
payment-id mismatch, event-type mismatch).

## Completed (admin dashboard foundation — PR #2)

- Protected, read-only `/admin` overview with confirmed revenue, ticket,
  check-in and pending-payment metrics.
- Event/category inventory and order/payment monitoring views, including
  prominent reconciliation alerts.
- Separate page/API authorization for admin/support roles; customer and
  scanner accounts cannot enter the back office.
- Admin authentication and access boundaries covered in Playwright; the
  full browser suite now runs in CI against disposable PostgreSQL data.

## Completed (atomic QR scanner — PR #3)

- Mobile-first authenticated `/scanner` interface with rear-camera QR
  decoding and a manual-code fallback.
- Atomic server-side check-in with explicit `VALID`, `ALREADY_USED`,
  `INVALID`, `CANCELLED` and `WRONG_EVENT` decisions; simultaneous scans
  cannot admit the same ticket twice.
- Scanner-only authorization boundary, network-only service worker, no
  insecure offline validation, and SHA-256 audit digests instead of raw
  bearer tokens.
- Six PostgreSQL integration tests plus three Playwright scanner/access
  tests, including concurrent scans from two devices.

## Completed (admin catalogue management — current branch)

- Authenticated event creation/editing, venue creation, category capacity
  management and sales-phase creation/editing in the back office.
- Only `admin` and `super_admin` can mutate the catalogue; `support`
  remains read-only and scanner/customer sessions remain excluded.
- Morocco wall-clock inputs are converted with the IANA
  `Africa/Casablanca` timezone (including seasonal offset changes), never
  with a hardcoded UTC offset.
- Catalogue writes and purchases coordinate through shared/exclusive
  transaction-scoped advisory locks. Capacity/phase limits cannot be
  reduced below committed quantities, active phase windows cannot overlap,
  and direct cancellation is blocked while tickets, live holds or pending
  payments exist.
- Every successful mutation writes its audit record in the same database
  transaction.

## Completed (admin CSV export + audit-log views — current branch)

- `/admin/audit`: paginated (cursor-based), entity-type-filterable view of
  every `AuditLog` row, with the acting admin's display name resolved
  best-effort (never blocking the page if a lookup misses).
- `/api/admin/orders/export`: CSV export of orders, respecting the same
  status filter as the orders page. Every cell is escaped against
  spreadsheet formula injection (`=`, `+`, `-`, `@` prefixes) and RFC4180
  quoting, with a UTF-8 BOM so Excel renders accented names correctly.
  Bounded to the most recent 20,000 orders — no pagination UI yet.
- Both are read-only: available to `admin`/`super_admin`/`support`, same
  role boundary as the rest of the dashboard; `scanner`/customer sessions
  are rejected.

## Completed (admin refund flow — current branch)

- `lib/orders/refund.ts::initiateRefund`: full or partial, admin/
  super_admin only (`support` stays read-only — no form rendered, and the
  Server Action re-checks the role itself regardless).
- Validates the requested amount against the payment's actual remaining
  refundable balance (`amountCents` minus the sum of prior `succeeded`
  refunds); a partial refund is only a legal transition from
  `paid`/`partially_refunded` — `paid_but_unfulfillable`/
  `reconciliation_required` orders (no fulfilled tickets to partially
  retain) accept only a full refund.
- On a full refund, every still-`valid` ticket is cancelled and its
  category's `sold_quantity` released for resale; an already-`used`
  ticket is left untouched and never resold.
- The Payment/Order row lock is held for the whole operation (provider
  call included), so concurrent refund attempts on the same payment
  serialize and their total can never exceed the paid amount. A provider
  failure is recorded (`Refund.status = 'failed'`, audited) without
  blocking a later retry — found and fixed during this session's own
  review: an earlier draft `throw`n mid-transaction on provider failure,
  which rolled back that very bookkeeping.
- `/admin/orders/[orderId]`: new order detail page (payments, refund
  history, tickets with status) linked from the orders list.

## Completed (transactional email — current branch)

- `lib/email/provider.ts` + `lib/email/fakeProvider.ts`
  (`ConsoleEmailProvider`): the same swappable-interface treatment as
  payments, since no real email provider has been chosen either —
  `ConsoleEmailProvider` logs the message and returns a fake id, no real
  delivery.
- `lib/email/notifications.ts`: `sendOrderConfirmationEmail` (order +
  payment confirmation + ticket delivery combined into one message, since
  all three become true at the same instant in this system),
  `sendPaymentFailedEmail`, `sendRefundConfirmationEmail`.
- Idempotency via a new `EmailLog` model, `UNIQUE(type, entity_type,
  entity_id)`, claimed with the same `INSERT ... ON CONFLICT DO NOTHING
  RETURNING id` idiom as `PaymentEvent` — a retriggering caller is a safe
  no-op, never a duplicate send.
- Triggered after the relevant transaction commits (payment webhook route;
  `lib/orders/refund.ts::initiateRefund`), never inside it. A send
  failure is logged and swallowed, never allowed to roll back or block
  the payment/refund it's reporting on.

## Completed (auth rate limiting — PR #8)

- `lib/rateLimit.ts`: an atomic Postgres-backed fixed-window counter shared
  by every serverless instance. Rejected counters cap at `limit + 1` and
  responses expose `Retry-After`/rate-limit reset metadata.
- Authentication uses two independent HMAC-pseudonymized buckets: a
  generous IP ceiling to avoid easy lockout of shared NATs, plus a tighter
  normalized-account/email ceiling that stops distributed guessing. The
  account bucket records failed credentials only; successful logins do not
  consume a user's failed-attempt budget.
- No raw IP or email is persisted in `rate_limit_buckets`; client-IP
  resolution prefers Vercel's platform header, validates IPv4/IPv6,
  canonicalizes IPv6, and collapses malformed input to `unknown`.
- Production startup fails if the HMAC secret is missing/weak or if rate
  limiting is disabled without the explicit isolated-test opt-in.
- The existing authenticated housekeeping route prunes buckets older than
  48 hours, preventing unbounded storage and indefinite IP-derived data
  retention.
- Limits remain conservative defaults pending real traffic. Platform-edge
  WAF rules must be staged in log mode and tuned before production; the DB
  limiter is defense in depth, not a DDoS shield.

## Completed (CSP + admin/scanner CSRF hardening — PR #9)

- Global browser security headers and CSP are configured in
  `next.config.ts`, including `object-src 'none'`, `base-uri 'self'`,
  `form-action 'self'`, `frame-ancestors 'none'`, `nosniff`, referrer and
  Permissions-Policy controls. The current policy deliberately remains
  compatible with Next.js static rendering instead of forcing a nonce on
  every page.
- `lib/auth/adminCsrf.ts` derives a session-bound HMAC synchronizer token
  from the opaque admin session token. The raw httpOnly session token never
  reaches client JavaScript.
- `/api/admin/login` rejects cross-site/origin-mismatched requests before
  credential lookup; logout and scanner mutations require both a matching
  source origin and the session-bound token.
- Sensitive catalogue/refund Server Actions also require the session-bound
  token as a hidden form field, in addition to Next.js's built-in
  Origin/Host validation and the action's own role check. The admin layout
  provides this automatically to every `AdminMutationForm` so future forms
  using that shared component inherit the protection.
- Origin comparison covers scheme + host + port and supports Vercel's
  documented `x-forwarded-host`/`x-forwarded-proto` shape; a matching unit
  test protects that deployment assumption. A real preview/custom-domain
  smoke test remains a pre-production deployment check.
- Independent review specifically checked token construction,
  timing-safe comparison, role/session boundaries, CSP/scanner
  compatibility and the historical Next.js Server Action CSRF advisory.
  The project uses Next.js 16.3.5, above that advisory's 16.1.7 fix.
- CI verifies the complete stack: typecheck, lint, migrations,
  unit/integration tests, isolated-Postgres Playwright flows and production
  build all pass.

## In progress

- None.

## Next

1. Select a Moroccan PSP and implement its real `PaymentProvider` adapter
   from official docs (never speculatively) — and, at that point,
   re-derive the reconciliation policy in
   `lib/orders/fulfillment.ts::reconcileContradictorySuccess` from that
   provider's actual documented event lifecycle rather than this
   session's conservative stopgap, and revisit whether `initiateRefund`
   still safely holds a row lock across the real (network) provider call.
2. Select a real email provider (Resend/Postmark/SES/...) and implement
   its adapter from official docs; add a background retry for a send
   that failed (currently logged and dropped — no retry mechanism yet).
3. Move local Playwright e2e tests off the dev database onto a dedicated
   ephemeral one. CI already runs them against an isolated ephemeral
   PostgreSQL service.
4. Decide production managed-Postgres provider and write the backup
   strategy doc mentioned in CLAUDE.md's Observability section.
5. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
   needs OnlyLive's accountant/lawyer and the eventual PSP's
   requirements; do not draft speculative legal text.
6. Make `MAX_TICKETS_PER_USER_PER_EVENT` (currently a global constant in
   `lib/inventory.ts`) per-event-configurable if OnlyLive needs
   different caps for different shows.
7. Paginate the orders CSV export (currently capped at the most recent
   20,000 rows with no way to reach older ones).
8. Add an automatic (rather than admin-noticed) trigger for
   `paid_but_unfulfillable`/`reconciliation_required` orders — the
   refund action to resolve them exists, but nothing surfaces them beyond
   the dashboard's attention metrics.
9. Stage Vercel WAF rate-limit rules in log mode before production, review
   real traffic, then tune/enforce them without replacing the application
   account-level limiter.
10. Before production rollout, smoke-test admin login/logout, catalogue
    mutation and scanner validation on the actual Vercel preview/custom
    domain so forwarded-host/protocol behavior is verified end to end.

## Blocked

- Real PSP integration is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review.

## Deferred (explicitly out of scope, per CLAUDE.md)

Offline scanning, real payment provider, real email provider, background
worker infrastructure beyond the sweep endpoint, database backup strategy
documentation.
