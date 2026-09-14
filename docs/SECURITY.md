# Security

Status of the CLAUDE.md security checklist as of this session. "Mitigated"
means a concrete, specific control exists (named below); "Not yet
implemented" is an explicit gap, not an oversight — tracked in TASKS.md.

| Risk | Status | Notes |
|---|---|---|
| XSS | Mitigated | React auto-escapes all rendered content; no `dangerouslySetInnerHTML` anywhere. No CSP header yet — tracked as a gap. |
| CSV/formula injection | Mitigated | `lib/admin/csv.ts` prefixes any cell starting with `=`, `+`, `-`, or `@` before it reaches Excel/Sheets, which would otherwise execute it as a formula; several exported fields (customer name, event title) ultimately trace back to user-supplied input. |
| CSRF | Partially mitigated | Auth.js's own endpoints (`/api/auth/*`) have built-in CSRF protection. Admin catalogue forms use Next.js Server Actions, which enforce same-origin `Origin`/`Host` checks, in addition to the admin cookie's `sameSite: "lax"`; every action still re-authenticates server-side. Other custom POST routes (`/api/holds`, `/api/checkout/*`, `/api/admin/login`, `/api/scanner/scan`, the webhook) retain the baseline cookie/JSON-body protection but no explicit CSRF token yet. |
| SQL injection | Mitigated | Prisma parameterizes all queries. Every raw-SQL call site (`lib/inventory.ts`, `lib/admin/catalog.ts`, `lib/orders/*`, `lib/scanner.ts`, the webhook route) uses `$queryRaw`/`$executeRaw` tagged templates exclusively — never string concatenation. |
| Broken access control / IDOR | Mitigated | Every sensitive route/action calls `requireCustomer()`/`requireAdminRole()` explicitly (never inferred from hidden UI). Catalogue and refund Server Actions allow only admin/super-admin; support is read-only (the order detail page renders no refund form for a support session, and the action itself re-checks the role server-side regardless). The audit-log view and orders CSV export allow admin/super-admin/support (read-only, same boundary as the rest of the dashboard) and reject scanner/customer sessions. Admin pages reject scanner accounts; scanner pages/API independently accept only scanner/admin/super-admin and reject customer/support sessions. Order/ticket ownership mismatches return **404**, not 403, so a non-owner can't even confirm the resource exists. |
| Mass assignment | Mitigated | Every write route destructures exactly the zod-validated fields (`lib/validation/*.ts`) into the Prisma `data` object — request bodies are never spread directly into `create`/`update`. |
| SSRF | N/A this session | No server-side fetch of user-supplied URLs exists yet. Revisit when image uploads or a real PSP redirect URL are added. |
| Open redirects | Mitigated | `startCheckout`'s `returnUrl` is built from `new URL(request.url).origin` server-side, never from client input. |
| Rate abuse / credential stuffing | Mitigated | `lib/rateLimit.ts`: a Postgres-backed fixed-window counter (no external cache in this app) applied per client IP to `/api/customers/register` (5/15min), `/api/admin/login` (5/15min), and the customer login `authorize()` callback (10/15min) — checked before any credential/existence check runs, so a rate-limited request never leaks anything about the account either. Per-account (rather than per-IP only) limiting is not implemented — a distributed attack spreading requests across many IPs against one account isn't caught. `RATE_LIMITING_DISABLED=true` (only ever set for the Playwright e2e `webServer`, see playwright.config.ts) bypasses this entirely — the suite performs many distinct logins/registrations that all originate from one local machine with no reverse proxy in front of it, so the server would otherwise see them as a single IP; never set this for a real deployment. |
| Email enumeration | Partially mitigated | `/api/admin/login` returns the identical `INVALID_CREDENTIALS` error for both "no such admin" and "wrong password". `/api/customers/register` **does** reveal whether an email is already registered (`EMAIL_TAKEN`, 409) — a deliberate, documented tradeoff for this session (registration UX), not an oversight; login itself does not leak this for customers either (next-auth's Credentials `authorize()` returns `null` uniformly on any failure). |
| Session fixation | Mitigated | Admin session tokens are freshly generated (`crypto.randomBytes(32)`) on every login and stored hashed; customer sessions are Auth.js JWTs signed with `NEXTAUTH_SECRET`, re-issued on sign-in. |
| Insecure cookies | Mitigated | Admin cookie: `httpOnly`, `sameSite: "lax"`, `secure` in production. Auth.js manages its own cookies with its standard secure defaults. |
| Secret exposure | Mitigated | All secrets via environment variables (`.env`, gitignored; `.env.example` has no real values). Argon2id hashes and HMAC-hashed admin session tokens are what's stored, never raw. |
| Webhook forgery | Mitigated | `FakeProvider.parseWebhook` verifies an HMAC-SHA256 signature (`X-OnlyLive-Fake-Signature`) with `crypto.timingSafeEqual`, using a secret (`FAKE_PSP_WEBHOOK_SECRET`) never sent to the browser — the fake pay page's buttons call a same-origin API route that signs server-side, not client JS. An invalid/missing signature is rejected with 401 and the event is still logged (with `signature_valid: false`) but never applied. A validly-signed event whose `amountCents`/`currency` don't match the `Payment` row is also rejected (409, audit-logged) — a valid signature alone is not sufficient. |
| Webhook replay / duplicate processing | Mitigated | `payment_events` has `UNIQUE (provider, external_event_id)`; the claim (insert) and the fulfillment transition run in one database transaction, so a crash between them can never leave a "claimed but not applied" event that a retry would silently skip — see docs/PAYMENTS.md's Atomicity section. Defense in depth: the order-state transition itself is also a guarded `UPDATE ... WHERE status = 'pending_payment'`, and the Payment row is locked for the whole transaction, so even a different event id (or a simultaneous conflicting event) for the same logical payment can't double-process or leave Payment/Order status diverged. Reclaiming an interrupted (unprocessed) event additionally verifies the resolved payment id, event type, and prior signature validity all still agree with what was originally claimed — an inconsistent collision (e.g. a different payment, a changed event type, or a previously-invalid-signature id resent with a valid one) is rejected and audited rather than reprocessed. See docs/PAYMENTS.md's Reclaim consistency section. |
| QR forgery | Mitigated | The validation token is 24 cryptographically random bytes (`crypto.randomBytes`), base64url-encoded — not a sequential id or derived from guessable input. Unknown tokens return `INVALID`; scan history stores only a SHA-256 digest of the presented bearer token, never a reusable copy. |
| QR replay (scan twice) | Mitigated | `scanTicket()` locks the ticket row using PostgreSQL `FOR UPDATE`, decides status, atomically flips `valid → used`, and records the result in one transaction. Two simultaneous scanners deterministically produce exactly one `VALID` and one `ALREADY_USED`; cancelled and wrong-event tickets never transition. |
| Duplicate payments / refunds | Mitigated | Payment idempotency as above, plus checkout-side idempotency: `OrderItem.reservationId` is `UNIQUE` (one reservation produces at most one Order/Payment), and a separate durable claim (`payments.provider_init_at`) ensures the external provider itself is only ever called once per Payment even when concurrent requests all see no stored redirect yet — a locked database row alone doesn't prevent that, since the provider call happens outside any transaction. `lib/orders/refund.ts::initiateRefund` holds the Payment/Order row lock for the whole operation (including the provider call), so concurrent refund attempts on the same payment serialize and their total can never exceed the paid amount; a failed provider call is recorded without blocking a later retry. See docs/PAYMENTS.md. |
| Sale-limit bypass / catalogue race | Mitigated | `createHold` enforces event/category/phase eligibility and a per-user/event purchase cap atomically. It takes a shared catalogue advisory lock while admin catalogue writes take the matching exclusive lock, so an event/category/phase cannot change after a purchase validates it but before stock is reserved. Capacity and phase-cap edits are also checked under the inventory row lock. See `tests/integration/hold-eligibility.test.ts` and `tests/integration/admin-catalog.test.ts`. |
| Fake payment provider reaching production | Mitigated | `PAYMENT_PROVIDER=fake` is refused at server boot (`instrumentation.ts`) and at every fake-payment route/page whenever `NODE_ENV=production`, unless `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true` is explicitly set — never for real traffic. See docs/PAYMENTS.md. |
| Captured payment silently stranded on a dead order | Mitigated | A validly-signed `payment.succeeded` arriving after the order was already `failed`/`cancelled` is never a silent no-op: it's routed to an atomic re-fulfillment attempt, landing on `paid` (ticket generated) if stock allows or `reconciliation_required` (audited, human-resolved) if not — `Payment.status` is set to `paid` either way, since money was captured regardless of order outcome. This is a stopgap policy pending the real PSP's official event-lifecycle documentation — see docs/PAYMENTS.md's Reconciliation section. |
| Checkout retry after hold expiry starting a new charge | Mitigated | Once provider initialization has started but not completed for a Payment, a retry is refused (`409 HOLD_EXPIRED`) if the reservation has since expired — checked directly, not dependent on the sweep having run — so a customer can't be charged for stock that was already released/resold. A retry after initialization *did* complete still returns the same stored redirect regardless of expiry. See docs/PAYMENTS.md. |

## Never logged

Passwords, password hashes, full payment card data (never handled — see
docs/PAYMENTS.md), Auth.js/admin session tokens, `NEXTAUTH_SECRET`,
`ADMIN_SESSION_SECRET`, `FAKE_PSP_WEBHOOK_SECRET`, raw QR validation
tokens presented to the scanner. Webhook payloads stored
in `payment_events.raw_payload` for the fake provider contain no secrets
by construction (just `{eventId, providerPaymentId, type, amountCents,
currency}`); a real PSP adapter must redact its payload before storage if
its webhooks ever include anything sensitive.

## Structured logging / error responses

`lib/http/errors.ts`'s `apiErrorResponse()` is the single place that turns
a caught error into an HTTP response: a known `ApiError` returns its
`{code, message}` (already written to be safe to show a client); anything
else is logged server-side via `console.error` and returns a generic
`{error: "INTERNAL_ERROR"}` with no stack trace or internal detail
leaked to the client.

## Admin bootstrap and password rotation

No default admin account is ever created silently. `prisma/seed.ts` only
creates/updates a `super_admin` when **both** `ADMIN_SEED_EMAIL` and
`ADMIN_SEED_PASSWORD` are set in the environment (password: 16+
characters, validated with zod); if either is missing, seeding skips
admin creation entirely and says so. The seed script never prints
credentials.

**Bootstrap procedure** (first admin, or any environment that needs one):

1. Generate a strong, unique password — e.g. `openssl rand -base64 24` or
   a password manager. Never reuse a password across environments.
2. Set `ADMIN_SEED_EMAIL` and `ADMIN_SEED_PASSWORD` as environment
   variables for that one run only (a deploy-time secret, a one-off
   shell export — not committed anywhere, not left in shell history if
   avoidable).
3. Run `npm run seed`.
4. Unset/rotate the environment variable value immediately after; treat
   the password as used/shared going forward.

**Rotation procedure**: re-run `npm run seed` with the same
`ADMIN_SEED_EMAIL` and a new `ADMIN_SEED_PASSWORD` — the upsert updates
`passwordHash` for an existing admin. The current catalogue interface does
not manage staff credentials, so password rotation remains a re-seed operation. A future self-service
password change must require the current password and invalidate the
administrator's existing sessions.

## Privacy

Registration collects only email, password, name, and an optional phone
number — the minimum needed to sell and deliver a ticket. QR codes carry
no personal data (see above). Placeholders for Privacy Policy, Terms &
Conditions, Refund Policy, and Legal Notice have **not** been drafted this
session — CLAUDE.md is explicit that Moroccan legal requirements must not
be invented; these need OnlyLive's accountant/lawyer and the eventual
payment provider's own requirements before being written.
