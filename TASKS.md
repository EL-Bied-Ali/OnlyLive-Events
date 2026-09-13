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
  VVIP/VIP/Gradins categories and Early Bird/Phase 1 sales phases, plus a
  `super_admin` AdminUser.
- Test suite: 25 Vitest unit/integration tests + 3 Playwright e2e tests,
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

## In progress

- None.

## Next

1. Admin dashboard UI (events/categories/phases/inventory/orders/
   payments/refunds/check-ins/stats/CSV export/audit logs) — the auth
   foundation for it already exists.
2. Scanner PWA + check-in endpoint (atomic VALID/ALREADY_USED/INVALID/
   CANCELLED/WRONG_EVENT determination) — `TicketScan` schema already
   exists.
3. Select a Moroccan PSP and implement its real `PaymentProvider` adapter
   from official docs (never speculatively).
4. Refund flow (schema exists, no UI/logic yet) and an automated
   resolution path for `paid_but_unfulfillable` orders.
5. Transactional email (order confirmation, ticket delivery, payment
   failure, refund confirmation) — must be idempotent, no duplicate
   tickets from a retried email job.
6. Rate limiting on `/api/customers/register`, customer login, and
   `/api/admin/login` (see docs/SECURITY.md — currently a documented gap).
7. CSP headers and a CSRF token for custom (non-Auth.js) state-changing
   admin routes.
8. Move Playwright e2e tests off the dev database onto a dedicated
   ephemeral one.
9. Decide production managed-Postgres provider and write the backup
   strategy doc mentioned in CLAUDE.md's Observability section.
10. Privacy Policy / Terms & Conditions / Refund Policy / Legal Notice —
    needs OnlyLive's accountant/lawyer and the eventual PSP's
    requirements; do not draft speculative legal text.
11. Make `MAX_TICKETS_PER_USER_PER_EVENT` (currently a global constant in
    `lib/inventory.ts`) per-event-configurable if OnlyLive needs
    different caps for different shows.

## Blocked

- Real PSP integration is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review.

## Deferred (explicitly out of scope, per CLAUDE.md)

Admin dashboard UI, scanner UI, real payment provider, email delivery,
background worker infrastructure beyond the sweep endpoint, rate
limiting, CSP headers, database backup strategy documentation.
