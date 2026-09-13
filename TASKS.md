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

## In progress

- None.

## Next

1. Extend the admin dashboard with refunds, CSV export and audit-log views.
   Event/category/phase creation and editing now exist.
2. Select a Moroccan PSP and implement its real `PaymentProvider` adapter
   from official docs (never speculatively) — and, at that point,
   re-derive the reconciliation policy in
   `lib/orders/fulfillment.ts::reconcileContradictorySuccess` from that
   provider's actual documented event lifecycle rather than this
   session's conservative stopgap.
3. Refund flow (schema exists, no UI/logic yet) and an automated
   resolution path for `paid_but_unfulfillable`/`reconciliation_required`
   orders — currently both require a human to notice and act.
4. Transactional email (order confirmation, ticket delivery, payment
   failure, refund confirmation) — must be idempotent, no duplicate
   tickets from a retried email job.
5. Rate limiting on `/api/customers/register`, customer login, and
   `/api/admin/login` (see docs/SECURITY.md — currently a documented gap).
6. CSP headers and a CSRF token for custom (non-Auth.js) state-changing
   admin routes.
7. Move local Playwright e2e tests off the dev database onto a dedicated
   ephemeral one. CI already runs them against an isolated ephemeral
   PostgreSQL service.
8. Decide production managed-Postgres provider and write the backup
   strategy doc mentioned in CLAUDE.md's Observability section.
9. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
    needs OnlyLive's accountant/lawyer and the eventual PSP's
    requirements; do not draft speculative legal text.
10. Make `MAX_TICKETS_PER_USER_PER_EVENT` (currently a global constant in
    `lib/inventory.ts`) per-event-configurable if OnlyLive needs
    different caps for different shows.

## Blocked

- Real PSP integration is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review.

## Deferred (explicitly out of scope, per CLAUDE.md)

Refund operations, CSV and audit views, offline scanning, real payment provider, email delivery,
background worker infrastructure beyond the sweep endpoint, rate
limiting, CSP headers, database backup strategy documentation.
