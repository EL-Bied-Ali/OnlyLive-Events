# Security

Status of the CLAUDE.md security checklist as of this session. "Mitigated"
means a concrete, specific control exists (named below); "Not yet
implemented" is an explicit gap, not an oversight — tracked in TASKS.md.

| Risk | Status | Notes |
|---|---|---|
| XSS | Mitigated | React auto-escapes all rendered content; no `dangerouslySetInnerHTML` anywhere. No CSP header yet — tracked as a gap. |
| CSRF | Partially mitigated | Auth.js's own endpoints (`/api/auth/*`) have built-in CSRF protection. Our custom POST routes (`/api/holds`, `/api/checkout/*`, `/api/admin/login`, the webhook) rely on cookie `sameSite: "lax"` plus JSON `content-type` requirements as a baseline; no explicit CSRF token yet on custom routes — tracked as a gap for the admin dashboard specifically, since it has session-cookie-based state-changing actions a browser could be tricked into replaying. |
| SQL injection | Mitigated | Prisma parameterizes all queries. The 8 raw-SQL call sites (`lib/inventory.ts`, `lib/orders/fulfillment.ts`, the webhook route) use `$queryRaw`/`$executeRaw` tagged templates exclusively — never string concatenation. |
| Broken access control / IDOR | Mitigated | Every sensitive route calls `requireCustomer()`/`requireAdminRole()` explicitly (never inferred from hidden UI). Order/ticket ownership mismatches return **404**, not 403, so a non-owner can't even confirm the resource exists. |
| Mass assignment | Mitigated | Every write route destructures exactly the zod-validated fields (`lib/validation/*.ts`) into the Prisma `data` object — request bodies are never spread directly into `create`/`update`. |
| SSRF | N/A this session | No server-side fetch of user-supplied URLs exists yet. Revisit when image uploads or a real PSP redirect URL are added. |
| Open redirects | Mitigated | `startCheckout`'s `returnUrl` is built from `new URL(request.url).origin` server-side, never from client input. |
| Rate abuse / credential stuffing | Not yet implemented | No rate limiting on `/api/customers/register`, `/login` (Auth.js Credentials callback), or `/api/admin/login`. Tracked as a gap — needed before production launch. |
| Email enumeration | Partially mitigated | `/api/admin/login` returns the identical `INVALID_CREDENTIALS` error for both "no such admin" and "wrong password". `/api/customers/register` **does** reveal whether an email is already registered (`EMAIL_TAKEN`, 409) — a deliberate, documented tradeoff for this session (registration UX), not an oversight; login itself does not leak this for customers either (next-auth's Credentials `authorize()` returns `null` uniformly on any failure). |
| Session fixation | Mitigated | Admin session tokens are freshly generated (`crypto.randomBytes(32)`) on every login and stored hashed; customer sessions are Auth.js JWTs signed with `NEXTAUTH_SECRET`, re-issued on sign-in. |
| Insecure cookies | Mitigated | Admin cookie: `httpOnly`, `sameSite: "lax"`, `secure` in production. Auth.js manages its own cookies with its standard secure defaults. |
| Secret exposure | Mitigated | All secrets via environment variables (`.env`, gitignored; `.env.example` has no real values). Argon2id hashes and HMAC-hashed admin session tokens are what's stored, never raw. |
| Webhook forgery | Mitigated | `FakeProvider.parseWebhook` verifies an HMAC-SHA256 signature (`X-OnlyLive-Fake-Signature`) with `crypto.timingSafeEqual`, using a secret (`FAKE_PSP_WEBHOOK_SECRET`) never sent to the browser — the fake pay page's buttons call a same-origin API route that signs server-side, not client JS. An invalid/missing signature is rejected with 401 and the event is still logged (with `signature_valid: false`) but never applied. A validly-signed event whose `amountCents`/`currency` don't match the `Payment` row is also rejected (409, audit-logged) — a valid signature alone is not sufficient. |
| Webhook replay / duplicate processing | Mitigated | `payment_events` has `UNIQUE (provider, external_event_id)`; the claim (insert) and the fulfillment transition run in one database transaction, so a crash between them can never leave a "claimed but not applied" event that a retry would silently skip — see docs/PAYMENTS.md's Atomicity section. Defense in depth: the order-state transition itself is also a guarded `UPDATE ... WHERE status = 'pending_payment'`, and the Payment row is locked for the whole transaction, so even a different event id (or a simultaneous conflicting event) for the same logical payment can't double-process or leave Payment/Order status diverged. |
| QR forgery | Mitigated | The validation token is 24 cryptographically random bytes (`crypto.randomBytes`), base64url-encoded — not a sequential id, not derived from any guessable input. |
| QR replay (scan twice) | Not yet implemented | The `Ticket.status`/`TicketScan` schema supports it (a scan handler would atomically flip `valid` → `used`), but no scanner endpoint exists yet this session. |
| Duplicate payments / refunds | Mitigated (payments) / Not yet implemented (refunds) | Payment idempotency as above, plus checkout-side idempotency (`OrderItem.reservationId` is `UNIQUE` — one reservation produces at most one Order/Payment even under concurrent or retried checkout requests; see docs/PAYMENTS.md). Refund flow itself (and its duplicate-refund guard) is schema-only this session. |
| Sale-limit bypass | Mitigated | `createHold` enforces event/category/phase eligibility and a per-user/event purchase cap (`MAX_TICKETS_PER_USER_PER_EVENT`) atomically inside its locked transaction — including across separate holds and across categories, via a `pg_advisory_xact_lock` keyed on `(eventId, userId)`. See `tests/integration/hold-eligibility.test.ts`. |
| Fake payment provider reaching production | Mitigated | `PAYMENT_PROVIDER=fake` is refused at server boot (`instrumentation.ts`) and at every fake-payment route/page whenever `NODE_ENV=production`, unless `ALLOW_FAKE_PAYMENTS_IN_PRODUCTION=true` is explicitly set — never for real traffic. See docs/PAYMENTS.md. |

## Never logged

Passwords, password hashes, full payment card data (never handled — see
docs/PAYMENTS.md), Auth.js/admin session tokens, `NEXTAUTH_SECRET`,
`ADMIN_SESSION_SECRET`, `FAKE_PSP_WEBHOOK_SECRET`. Webhook payloads stored
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
`passwordHash` for an existing admin. Once the admin dashboard exists,
password changes should move there (self-service, with the current
password required); until then, this re-seed is the only rotation path.

## Privacy

Registration collects only email, password, name, and an optional phone
number — the minimum needed to sell and deliver a ticket. QR codes carry
no personal data (see above). Placeholders for Privacy Policy, Terms &
Conditions, Refund Policy, and Legal Notice have **not** been drafted this
session — CLAUDE.md is explicit that Moroccan legal requirements must not
be invented; these need OnlyLive's accountant/lawyer and the eventual
payment provider's own requirements before being written.
