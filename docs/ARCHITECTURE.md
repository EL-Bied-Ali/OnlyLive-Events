# Architecture

## Stack and why

- **Node.js 24 LTS, TypeScript + Next.js 16 (App Router), React 19.**
  Node 24 is required by the current ZXing QR decoder and is supported by
  the target Vercel runtime; CI enforces the same major version.
- **PostgreSQL is the source of truth**, accessed via **Prisma 7** +
  `@prisma/adapter-pg` (Prisma 7 requires a driver adapter instead of a
  schema-level connection URL — see `prisma.config.ts` / `lib/db.ts`). The
  one safety-critical section (inventory locking) bypasses the query
  builder and uses raw parameterized SQL inside `prisma.$transaction`, so
  the exact locking statements are hand-controlled regardless of ORM.
- **Auth, dual-track:**
  - Customers: **Auth.js v4 (`next-auth`)**, Credentials provider,
    **JWT session strategy**. Originally planned as database sessions
    (server-revocable), but next-auth v4's Credentials provider only
    supports JWT sessions — it throws `CALLBACK_CREDENTIALS_JWT_ERROR`
    under the database strategy, since there's no OAuth account row to
    hang a session off of. This was caught by the Playwright e2e suite,
    not by inspection. See docs/SECURITY.md for the resulting tradeoff.
  - Admin/scanner staff: a **separate, minimal custom session**
    (`AdminSession` table, HMAC-hashed bearer token, own httpOnly cookie
    `onlylive_admin_session`). Deliberately not Auth.js and not Lucia
    (Lucia no longer ships as a maintained package) — this keeps
    admin/scanner access on a code path a bug in the customer stack can
    never reach.
  - Both converge on one rule: **authorization is decided in server route
    handlers**, never inferred from `middleware.ts` (which can't safely
    run Prisma on the Edge runtime anyway) or hidden frontend UI.
- **Tests:** Vitest (unit + integration, against a real local Postgres —
  lock contention can't be faithfully mocked) and Playwright (customer
  purchase flow, access-control checks, admin authentication/UI and the
  scanner staff flow).
- **CI** (`.github/workflows/ci.yml`): `npm ci` → `prisma generate` →
  typecheck → lint → apply migrations to a Postgres service container →
  `npm test` → seed isolated browser-test data → Playwright →
  `npm run build`. `postinstall: prisma generate` in
  `package.json` makes a fresh `npm install`/`npm ci` reproducible without
  a manual generate step; `prisma.config.ts` deliberately reads
  `process.env.DATABASE_URL` directly (not `@prisma/config`'s throwing
  `env()` helper) so `prisma generate` never requires a live database
  connection — only `migrate`/`db push` genuinely need one.

## Local dev environment note

This sandbox has no reachable Docker daemon, so Postgres runs via the
already-installed **PostgreSQL 16 apt package** (`sudo service postgresql
start`), not `docker-compose`. Two local databases: `onlylive_dev` and
`onlylive_test` (the latter used only by the Vitest integration suite —
see `tests/setup.ts`, which refuses to run without `TEST_DATABASE_URL`
set, precisely so tests can never accidentally hit dev data). Production
deployment should target a managed Postgres (Neon/Supabase/RDS — **not
yet decided**) compatible with Vercel.

Playwright's `webServer` in this environment needed an explicit Chromium
`executablePath` (`PLAYWRIGHT_CHROMIUM_PATH` env var, read in
`playwright.config.ts`) because the pinned `@playwright/test` version
defaults to looking for a `headless_shell` build that isn't preinstalled
here. Elsewhere, a normal `npx playwright install` (or an already-correct
preinstalled browser) makes this unnecessary — leave the env var unset.

## Folder structure

```
instrumentation.ts  boot-time config validation (payment provider)
/prisma            schema.prisma, migrations/, seed.ts
/app
  (marketing)/      event listing + detail (public)
  (customer)/       login, register, checkout, fake-pay sandbox, orders, tickets
  (admin-auth)/      separate admin login
  (admin)/           protected overview, catalogue management, orders
  (scanner-auth)/    scanner-specific staff login
  (scanner)/         online-only mobile QR scanner PWA
  api/              route handlers (see below)
/lib
  db.ts             Prisma client singleton (driver adapter)
  admin/             dashboard queries + atomic catalogue mutations
  auth/             customer.ts (Auth.js), admin.ts (custom session), password.ts
  inventory.ts      the oversell-prevention critical section
  orders/           stateMachine.ts, fulfillment.ts, checkout.ts
  payments/         provider.ts (interface), fakeProvider.ts, index.ts (factory)
  scanner.ts         atomic ticket validation + scan audit records
  tickets.ts        validation token + QR
  audit.ts          writeAuditLog()
  validation/       zod schemas per route
/tests
  unit/, integration/   Vitest, against onlylive_test
  e2e/                  Playwright, local dev DB / isolated CI DB
/docs               this file, SECURITY.md, PAYMENTS.md
TASKS.md, tests.json
```

## Request/data flow: browse → ticket

1. `GET /events/[slug]` — Server Component reads `Event` → `TicketCategory`
   → `SalesPhase` → `Inventory`, computes `available = total - reserved -
   sold` for display. This number is **never** trusted for the actual
   purchase decision — every hold re-validates from the database inside a
   lock (`lib/inventory.ts`).
2. `POST /api/holds` — `requireCustomer()`, calls `createHold()`, which
   atomically re-validates full sales eligibility (event status/window,
   category active, phase active/window/quantity-limit, a per-user/event
   purchase cap) and price entirely inside its own locked transaction —
   never from a pre-transaction read or the client.
3. `POST /api/checkout/[holdId]/start` — idempotently ensures exactly one
   `Order`/`Payment` exists for the reservation (safe under retries and
   concurrency — see docs/PAYMENTS.md), extends the hold's expiry, then
   calls `PaymentProvider.createPayment()`.
4. Customer is redirected to the provider's hosted checkout (today:
   `/pay/fake/[paymentId]`, our own sandbox page — refuses to operate in
   production without an explicit opt-in, see docs/PAYMENTS.md).
5. The provider's webhook (`POST /api/payments/webhook/fake`) verifies the
   signature and the paid amount/currency, records the event idempotently,
   and calls `confirmOrderPayment()`/`failOrderPayment()` — the **only**
   place tickets are ever created. The whole thing (claim + fulfillment +
   Payment status update) is one database transaction; see
   docs/PAYMENTS.md's Atomicity section.
6. `GET /orders/[orderId]` and the ticket page render the result, with
   ownership checked server-side on every load.

## Request/data flow: scan → admission

1. `/scanner` is server-protected by `requireScannerForPage()` and only
   accepts `scanner`, `admin`, or `super_admin`; support/customer sessions
   cannot reach the validation API.
2. The client reads QR codes with `@zxing/browser` and posts only the
   selected `eventId` plus opaque validation token to
   `POST /api/scanner/scan`. A manual-entry fallback exercises the same
   endpoint.
3. `lib/scanner.ts::scanTicket()` verifies the selected event and locks
   the matching `tickets` row with `SELECT ... FOR UPDATE`. It decides
   `VALID`, `ALREADY_USED`, `INVALID`, `CANCELLED`, or `WRONG_EVENT` and
   writes the `TicketScan` record in that same transaction. For `VALID`,
   the `valid → used` transition also happens before commit, so concurrent
   scanners cannot both admit the holder.
4. `ticket_scans.scanned_token` stores a SHA-256 digest, never the raw QR
   bearer token. Known tickets are correlated through `ticket_id`; an
   invalid token remains useful for abuse correlation without becoming a
   reusable credential if the audit table leaks.
5. The service worker is intentionally network-only. When the browser is
   offline the UI blocks validation; no cached/offline decision can admit
   a duplicate ticket.

## Request/data flow: admin catalogue mutation

1. Admin pages read directly from PostgreSQL as Server Components. Forms
   submit internal Next.js Server Actions; each action authenticates again
   with `requireAdminRole(["super_admin", "admin"])` before validation or
   mutation. `support` is intentionally read-only.
2. Zod accepts only named fields. Event wall-clock inputs are converted
   through the IANA `Africa/Casablanca` timezone, including Morocco's
   seasonal offset changes, before UTC instants are stored.
3. `lib/admin/catalog.ts` performs each mutation and its `AuditLog` insert
   in one Prisma transaction. Category capacity cannot fall below
   reserved + sold inventory; phase caps cannot fall below live/converted
   reservations; active phase windows cannot overlap.
4. Purchases take a shared transaction-scoped catalogue advisory lock;
   catalogue writes take the matching exclusive lock. Many purchases can
   still proceed concurrently, while an admin edit can never race a hold
   that validated the old event/category/phase state.
5. Setting an event to `cancelled` is refused if any ticket, unexpired hold
   or pending-payment order exists. The dedicated cancellation/refund flow
   must be implemented before those cases can be resolved safely.

## Request/data flow: admin refunds

1. `/admin/orders/[orderId]` (a Server Component, protected by the shared
   admin layout) shows each payment's remaining refundable balance and,
   for `admin`/`super_admin` sessions only, a refund form; `support`
   never sees the form regardless of balance.
2. Its Server Action (`refundPaymentAction`) re-checks
   `requireAdminRole(["super_admin", "admin"])` itself — the page hiding
   the form is a UX nicety, not the enforcement.
3. `lib/orders/refund.ts::initiateRefund` does the actual work: locks the
   Payment/Order rows for the whole operation (provider call included),
   validates the requested amount against what's actually still
   refundable, calls `PaymentProvider.refund()`, and — on a full refund
   only — cancels every still-`valid` ticket and releases its category's
   `sold_quantity`. See docs/PAYMENTS.md's Refunds section for why the
   provider call never `throw`s out of the transaction (it would roll
   back the "mark this attempt failed" bookkeeping along with it).

## Request/data flow: admin reporting (audit log + CSV export)

1. `/admin/audit` and `GET /api/admin/orders/export` are both read-only
   and open to `admin`/`super_admin`/`support` — the same boundary as the
   rest of the dashboard; `scanner`/customer sessions are rejected.
2. The audit log is paginated with an `id`-based cursor (`lib/admin/audit.ts`)
   rather than an offset, since `audit_logs` is append-only and can grow
   without bound. `actorId` isn't a declared foreign key (it can point at
   an `AdminUser`, a customer `User`, or be `null` for system actions), so
   the admin's display name is resolved best-effort for display only and
   never blocks the page if the lookup misses.
3. The CSV export (`lib/admin/csv.ts`) escapes every cell against
   spreadsheet formula injection (a cell opened by Excel/Sheets starting
   with `=`, `+`, `-`, or `@` can execute as a formula) and RFC4180
   quoting, and prefixes the file with a UTF-8 BOM so Excel on Windows
   renders accented names correctly. It is bounded to the most recent
   20,000 orders — there is no pagination UI for the export yet.

## Deployment

Target: Vercel or an equivalent Node.js serverless/edge-capable platform.
Every route touching Prisma, Node crypto, or sessions declares
`export const runtime = "nodejs"` explicitly (these cannot run on the Edge
runtime).

### Environment variables

See `.env.example` for the full list and generation instructions
(`DATABASE_URL`, `TEST_DATABASE_URL`, `NEXTAUTH_SECRET`, `NEXTAUTH_URL`,
`ADMIN_SESSION_SECRET`, `PAYMENT_PROVIDER`,
`ALLOW_FAKE_PAYMENTS_IN_PRODUCTION`, `FAKE_PSP_WEBHOOK_SECRET`,
`INTERNAL_API_SECRET`, and the seed-only `ADMIN_SEED_EMAIL`/
`ADMIN_SEED_PASSWORD`). `instrumentation.ts` validates
`PAYMENT_PROVIDER`/`ALLOW_FAKE_PAYMENTS_IN_PRODUCTION` once at server
boot, so a misconfigured production deployment fails to start rather than
failing on the first webhook — see docs/PAYMENTS.md.

### Morocco timezone data depends on the Node runtime's bundled tzdata

`lib/validation/catalog.ts`'s `parseMoroccoDateTime`/`formatMoroccoDateTime`
resolve Africa/Casablanca wall-clock times via the Node runtime's own ICU
timezone database, deliberately, since Morocco reverts to UTC+0 for a
government-decreed window around Ramadan each year and otherwise stays at
UTC+1 — a rule no application code should hardcode. The reversion window
for a not-yet-reached year is only published a year or so ahead, so two
Node builds released at different times can bundle different projections
for the same future date (observed directly: Node 22 and Node 24 disagreed
on a December 2026 instant during this PR's review). Practical
consequence: pin the exact Node version across dev/CI/production, and
re-verify event start/sales-window times shown in the admin UI after any
Node upgrade for events scheduled near a Ramadan boundary. See
`tests/unit/catalog-validation.test.ts` for why its regression dates are
historical rather than future.

## Known scope limitations (deferred, tracked in TASKS.md)

- **Admin operations** — event/category/phase creation/editing, CSV order
  export, the audit-log view, and full/partial refunds all exist.
- **Offline scanning** — deliberately unsupported. The scanner PWA blocks
  validation without a live server connection because safe offline
  multi-device reconciliation is not implemented.
- **Real payment provider** — no Moroccan PSP is integrated; only the
  `fake` sandbox provider. See docs/PAYMENTS.md.
- **Email delivery** — no transactional email sending yet.
- **Rate limiting, CSP headers** — not yet implemented; see
  docs/SECURITY.md for the full checklist status.
- **`paid_but_unfulfillable`/`reconciliation_required` orders** are
  surfaced in the admin dashboard's attention metrics and can be resolved
  with a full refund from the order detail page, but there is still no
  *automatic* trigger — an admin has to notice and act.
- **Local E2E tests run against the dev database**, not an isolated
  ephemeral one. CI uses its disposable PostgreSQL service, but local
  runs should move to a dedicated e2e database (or transaction-per-test
  rollback) as the suite grows.
