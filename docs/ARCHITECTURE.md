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
  typecheck → lint → create separate Vitest/Playwright databases → apply
  migrations → `npm test` → Playwright (which independently resets,
  migrates and seeds its own database) → `npm run build`.
  `postinstall: prisma generate` in `package.json` makes a fresh
  `npm install`/`npm ci` reproducible without a manual generate step;
  `prisma.config.ts` deliberately reads `process.env.DATABASE_URL`
  directly (not `@prisma/config`'s throwing `env()` helper) so
  `prisma generate` never requires a live database connection — only
  `migrate`/`db push` genuinely need one.

## Local dev environment note

This sandbox has no reachable Docker daemon, so Postgres runs via the
already-installed **PostgreSQL 16 apt package** (`sudo service postgresql
start`), not `docker-compose`. Local development uses three separate
logical databases:

- `onlylive_dev` (`DATABASE_URL`) — development application data only.
- `onlylive_test` (`TEST_DATABASE_URL`) — Vitest unit/integration data;
  `tests/setup.ts` refuses to run without this variable.
- `onlylive_e2e` (`E2E_DATABASE_URL`) — Playwright only. `npm run
  test:e2e` destructively resets this database before every browser run.
  `scripts/e2eDatabaseSafety.ts` refuses the reset unless the database
  name contains an explicit `e2e` segment and is distinct from both dev
  and Vitest databases.

Playwright also starts its **own** production-mode Next.js server on port
3100 by default (`PLAYWRIGHT_PORT` can change it) and never reuses an
already-running developer server. Both the Playwright runner's direct
Prisma imports and the spawned server are forced to `E2E_DATABASE_URL`, so
there is no path back to development data through `reuseExistingServer` or
a mismatched server environment.

Playwright's `webServer` in this environment may need an explicit Chromium
`executablePath` (`PLAYWRIGHT_CHROMIUM_PATH` env var, read in
`playwright.config.ts`) because the pinned `@playwright/test` version can
look for a `headless_shell` build that isn't preinstalled here. Elsewhere,
a normal `npx playwright install` (or an already-correct preinstalled
browser) makes this unnecessary — leave the env var unset.

Production deployment should target a managed Postgres
(Neon/Supabase/RDS — **not yet decided**) compatible with Vercel.

## Folder structure

```
instrumentation.ts  boot-time config validation (payment provider)
/prisma            schema.prisma, migrations/, seed.ts
/scripts           guarded local/CI test-database preparation
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
  auth/             customer.ts (Auth.js), admin.ts (custom session), adminCsrf.ts
  inventory.ts      the oversell-prevention critical section
  orders/           stateMachine.ts, fulfillment.ts, checkout.ts, refund.ts
  payments/         provider.ts (interface), fakeProvider.ts, index.ts (factory)
  email/            provider.ts (interface), fakeProvider.ts, index.ts (factory),
                    notifications.ts (enqueue), dispatcher.ts (claim/send/retry)
  appUrl.ts         absolute-URL helper shared by email content and elsewhere
  scanner.ts         atomic ticket validation + scan audit records
  tickets.ts        validation token + QR
  audit.ts          writeAuditLog()
  rateLimit.ts      Postgres-backed fixed-window rate limiter
  validation/       zod schemas per route
/tests
  unit/, integration/   Vitest, against onlylive_test
  e2e/                  Playwright, against onlylive_e2e
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
   `POST /api/scanner/scan`. The request also carries the session-bound
   admin/scanner CSRF token in `X-CSRF-Token`; the route rejects requests
   that fail the exact source-origin check or token verification. A manual
   entry fallback exercises the same endpoint.
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
   with `requireAdminRole(["super_admin", "admin"])` and verifies the
   session-bound CSRF token supplied automatically by `AdminMutationForm`
   before validation or mutation. This is defense in depth on top of
   Next.js's own Server Action Origin-vs-Host validation. `support` is
   intentionally read-only.
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
   `requireAdminRole(["super_admin", "admin"])` and the session-bound CSRF
   token itself before touching the refund input. The page hiding the form
   is a UX nicety, not the enforcement, and Next.js's own Server Action
   Origin check remains an additional layer.
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

## Request/data flow: transactional email (durable outbox)

A production-safe outbox/dispatcher foundation — no real email provider is
integrated yet (see Known scope limitations below).

1. `lib/email/provider.ts` defines the same kind of swappable interface as
   payments — `lib/email/fakeProvider.ts` (`ConsoleEmailProvider`) just
   logs the message and returns a fake id. `SendEmailInput` carries an
   `idempotencyKey` (mirroring `RefundInput`'s), so a retried send of the
   same outbox row can never double-send at a real provider's own layer.
2. `lib/email/notifications.ts::enqueue*` (`enqueueOrderConfirmationEmail`,
   `enqueuePaymentFailedEmail`, `enqueueRefundConfirmationEmail`,
   `enqueueReconciliationAlertEmail`) each take a `Prisma.TransactionClient`
   and insert one or more `EmailOutbox` rows via
   `createMany({ skipDuplicates: true })`, keyed by the same
   `UNIQUE(type, entity_type, entity_id)` idempotency pattern `PaymentEvent`
   uses. Callers enqueue **inside the same transaction as the business
   fact** — the payment webhook route enqueues right after
   `tx.payment.update(...)` (based on the fulfillment outcome: `paid` →
   confirmation, `failed`/`cancelled` → failure notice,
   `paid_but_unfulfillable`/`reconciliation_required` → one row per active
   admin/super_admin, keyed by `entityId = "${orderId}:${adminUserId}"`),
   and `lib/orders/refund.ts::initiateRefund` enqueues right after its
   `refund.succeeded` audit log write, all before the transaction commits.
   This closes the gap in the previous after-commit design: once the
   business fact is durable, so is the obligation to notify about it — a
   crash or thrown error between "commit" and "send" can no longer lose
   the notification silently.
3. `lib/email/dispatcher.ts::dispatchPendingEmails` runs separately,
   out-of-band (invoked by `/api/internal/dispatch-emails` on the same
   `X-Internal-Secret` auth pattern as `sweep-expired-holds`, meant to run
   on a schedule):
   - Claims a batch of due rows with `SELECT ... FOR UPDATE SKIP LOCKED`
     (pending rows whose `nextAttemptAt` has arrived, or `processing` rows
     whose lease has expired — a crashed worker never finished them) —
     overlapping/concurrent invocations get disjoint batches, never double-
     sending the same row.
   - Re-renders each row's content fresh from current data and re-validates
     the business state it depends on (e.g. an order confirmation still
     sends for `paid` or `partially_refunded` — a partial refund never
     cancels tickets, only a full one does — but not for `refunded` or any
     other status) before sending — a row whose underlying entity moved on
     since it was enqueued is marked `failed` with
     `entity_state_no_longer_valid` rather than sending stale/wrong content.
     A row-level try/catch means a rendering exception (not just a provider
     send failure) is retried on its own and never aborts the rest of the
     claimed batch.
   - On a provider failure, retries with bounded exponential backoff plus
     jitter, up to 8 attempts, before marking the row permanently `failed`.
   - Never logs a raw recipient address (a truncated SHA-256 hash only) or
     a full error object (a bounded message only).

## Rate limiting

`lib/rateLimit.ts::consumeRateLimit` is a fixed-window counter backed by
Postgres (no Redis/external cache exists in this app). Its atomic upsert is
shared by concurrent requests and serverless instances. Every auth flow
uses both a generous per-IP ceiling and a tighter per-account/email ceiling:
the former reduces bulk abuse without letting a few mistakes block a whole
shared NAT, while the latter stops distributed guessing against one account.
Only failed credentials consume the account-level login bucket; a successful
login still counts toward the broader IP ceiling but cannot lock its own
account simply through legitimate repeated sign-ins. Identifiers are
HMAC-pseudonymized with `RATE_LIMIT_KEY_SECRET`; raw IPs and emails are never
stored in `rate_limit_buckets`.

IP resolution prefers `x-vercel-forwarded-for`, falls back to
`x-forwarded-for`, accepts only valid IPv4/IPv6, and canonicalizes IPv6.
Malformed/missing values share a conservative `unknown` bucket instead of
creating attacker-selected keys. Production startup rejects a missing/weak
HMAC key and rejects `RATE_LIMITING_DISABLED=true` unless the explicit
isolated-test opt-in is also set. Rejections include `Retry-After` and reset
metadata where the route controls the HTTP response (Auth.js Credentials
still owns the customer-login HTTP response).

The authenticated expired-hold housekeeping endpoint also deletes buckets
older than 48 hours. This limiter protects application authentication work;
it is not a DDoS shield. Vercel WAF rate limiting remains a deployment task
to stage in log mode, observe, and tune against real traffic before enforcing.

## Browser security / admin CSRF

`next.config.ts` applies the baseline CSP and browser-security headers to all
routes. The current CSP deliberately avoids nonce-based rendering because a
nonce would make otherwise-static pages dynamic; `docs/SECURITY.md` records
that trade-off and the directives that must be revisited when a real PSP or
remote event-image host is selected.

Custom cookie-authenticated admin/scanner Route Handlers use
`lib/auth/adminCsrf.ts`: an HMAC token bound to the opaque admin session is
verified together with an exact source-origin check. Pre-authentication admin
login cannot derive a session token yet, so it applies the origin / Referer /
Fetch-Metadata checks before credential work. Catalogue and refund Server
Actions receive the same derived token through a hidden field injected by the
shared `AdminMutationForm`, and verify it again server-side. Vercel's
documented `x-forwarded-host` / `x-forwarded-proto` request shape has a unit
regression test; a real preview/custom-domain smoke test remains required
before production rollout.

## Test database isolation

`npm run test:e2e` first executes `scripts/prepare-e2e-db.ts`. Its pure
safety gate (`scripts/e2eDatabaseSafety.ts`) validates the configured URL
before any destructive command can run: the URL must be PostgreSQL, the
named database must contain an explicit `e2e` segment, and it must not be
the configured development or Vitest database. Only after those checks does
the script run `prisma migrate reset --force` against the isolated URL and
seed deterministic browser-test data.

`playwright.config.ts` then overwrites the runner process's `DATABASE_URL`
with `E2E_DATABASE_URL` before e2e test modules are loaded, and passes the
same URL to the dedicated `next start` process. `reuseExistingServer` is
always false and arbitrary external base URLs are not supported by this
config, preventing an otherwise easy mismatch where tests prepare one DB
but exercise a different already-running application. CI provisions a
third disposable database (`onlylive_ci_e2e`) and executes this exact same
path, so the local safety behavior is continuously verified.

## Deployment

Target: Vercel or an equivalent Node.js serverless/edge-capable platform.
Every route touching Prisma, Node crypto, or sessions declares
`export const runtime = "nodejs"` explicitly (these cannot run on the Edge
runtime).

### Environment variables

See `.env.example` for the full list and generation instructions
(`DATABASE_URL`, `TEST_DATABASE_URL`, `E2E_DATABASE_URL`, `NEXTAUTH_SECRET`,
`NEXTAUTH_URL`, `ADMIN_SESSION_SECRET`, `PAYMENT_PROVIDER`,
`ALLOW_FAKE_PAYMENTS_IN_PRODUCTION`, `FAKE_PSP_WEBHOOK_SECRET`,
`INTERNAL_API_SECRET`, `RATE_LIMIT_KEY_SECRET`, the test-only
`RATE_LIMITING_DISABLED`/`ALLOW_RATE_LIMITING_DISABLED_IN_PRODUCTION`,
optional local `PLAYWRIGHT_PORT`, and the seed-only `ADMIN_SEED_EMAIL`/
`ADMIN_SEED_PASSWORD`). `instrumentation.ts` validates payment-provider
and rate-limit safety once at server boot, so a misconfigured production
deployment fails to start rather than failing on the first customer
request.

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
- **Real email provider** — the durable outbox/dispatcher foundation is in
  place (idempotent enqueue in the same transaction as the business fact,
  batched claiming, lease-timeout reclaim, retry with backoff, business-
  state re-validation at send time), but sending still only goes through
  the `console` sandbox provider (logs the message, no real delivery) — no
  real provider (Resend/Postmark/SES/...) is integrated yet. Adding one is
  a new `EmailProvider` implementation plus a `getEmailProvider()` case; no
  change to the outbox/dispatcher is expected.
- **Rate limiting** — implemented in the application per IP and per
  account/email on registration, admin login, and customer login
  (`lib/rateLimit.ts`). Production WAF rules and final thresholds still
  require observed traffic and a staged rollout.
- **CSP / admin CSRF** — implemented in the application. The CSP is a
  compatibility baseline rather than a nonce-based strict CSP, and the
  actual Vercel preview/custom-domain deployment must be smoke-tested before
  production to confirm its forwarded-origin shape and required external
  origins.
- **`paid_but_unfulfillable`/`reconciliation_required` orders** are
  surfaced in the admin dashboard's attention metrics and can be resolved
  with a full refund from the order detail page, but there is still no
  *automatic* trigger — an admin has to notice and act.
