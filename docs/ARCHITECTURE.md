# Architecture

## Stack and why

- **TypeScript + Next.js 16 (App Router), React 19.** Mandated by CLAUDE.md.
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
  lock contention can't be faithfully mocked) and Playwright (one
  end-to-end purchase flow + HTTP-level access-control checks).
- **CI** (`.github/workflows/ci.yml`): `npm ci` → `prisma generate` →
  typecheck → lint → apply migrations to a Postgres service container →
  `npm test` → `npm run build`. `postinstall: prisma generate` in
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
  api/              route handlers (see below)
/lib
  db.ts             Prisma client singleton (driver adapter)
  auth/             customer.ts (Auth.js), admin.ts (custom session), password.ts
  inventory.ts      the oversell-prevention critical section
  orders/           stateMachine.ts, fulfillment.ts, checkout.ts
  payments/         provider.ts (interface), fakeProvider.ts, index.ts (factory)
  tickets.ts        validation token + QR
  audit.ts          writeAuditLog()
  validation/       zod schemas per route
/tests
  unit/, integration/   Vitest, against onlylive_test
  e2e/                  Playwright, against onlylive_dev (see below)
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

## Known scope limitations (deferred, tracked in TASKS.md)

- **Admin dashboard UI** — the auth foundation (AdminUser/AdminSession,
  `requireAdminRole()`, login/logout routes) exists; no dashboard pages.
- **Scanner UI** — `TicketScan` table exists so a future migration isn't
  needed, but there is no scanner PWA or check-in endpoint yet.
- **Real payment provider** — no Moroccan PSP is integrated; only the
  `fake` sandbox provider. See docs/PAYMENTS.md.
- **Email delivery** — no transactional email sending yet.
- **Rate limiting, CSP headers** — not yet implemented; see
  docs/SECURITY.md for the full checklist status.
- **Refunds** — schema exists (`Refund` model,
  `PaymentProvider.refund()`), no refund flow/UI is wired up.
- **`paid_but_unfulfillable` orders** have no automated resolution path
  yet (should trigger an admin alert and/or automatic refund once the
  admin dashboard and refund flow exist).
- **E2E tests run against the dev database**, not an isolated ephemeral
  one — acceptable for this session's single scaffolded flow, but should
  move to a dedicated e2e database (or transaction-per-test rollback) as
  the suite grows.
