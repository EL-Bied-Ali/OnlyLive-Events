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

## In progress

- None — first-session scope is complete pending final review.

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

## Blocked

- Real PSP integration is blocked on OnlyLive selecting a provider.
- Legal document drafting is blocked on legal/accountant review.

## Deferred (explicitly out of scope this session, per CLAUDE.md)

Admin dashboard UI, scanner UI, real payment provider, email delivery,
background worker infrastructure beyond the sweep endpoint, rate
limiting, CSP headers, database backup strategy documentation.
