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
2. `POST /api/holds` — `requireCustomer()`, re-fetches the phase server-side
   (price and eligibility window never come from the client), calls
   `createHold()`.
3. `POST /api/checkout/[holdId]/start` — extends the hold's expiry,
   creates `Order` + `OrderItem` + `Payment`, calls
   `PaymentProvider.createPayment()`.
4. Customer is redirected to the provider's hosted checkout (today:
   `/pay/fake/[paymentId]`, our own sandbox page).
5. The provider's webhook (`POST /api/payments/webhook/fake`) verifies the
   signature, records the event idempotently, and calls
   `confirmOrderPayment()`/`failOrderPayment()` — the **only** place
   tickets are ever created.
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
`ADMIN_SESSION_SECRET`, `PAYMENT_PROVIDER`, `FAKE_PSP_WEBHOOK_SECRET`,
`INTERNAL_API_SECRET`).

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
- **Per-phase soft cap** (`SalesPhase.phaseQuantityLimit`) is enforced as
  a best-effort check, not the safety-critical constraint — the hard,
  atomically-enforced cap lives at the `TicketCategory` level via
  `Inventory`. Documented tradeoff, not a bug: two independent
  atomically-enforced counters (phase and category) would require
  cross-transaction coordination for no real benefit at this stage.
- **Refunds** — schema exists (`Refund` model,
  `PaymentProvider.refund()`), no refund flow/UI is wired up.
- **`paid_but_unfulfillable` orders** have no automated resolution path
  yet (should trigger an admin alert and/or automatic refund once the
  admin dashboard and refund flow exist).
- **E2E tests run against the dev database**, not an isolated ephemeral
  one — acceptable for this session's single scaffolded flow, but should
  move to a dedicated e2e database (or transaction-per-test rollback) as
  the suite grows.
