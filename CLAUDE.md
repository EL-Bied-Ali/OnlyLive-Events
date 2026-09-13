# CLAUDE.md — Permanent Project Rules (OnlyLive Ticketing Platform)

This file is the source of truth for how Claude Code must work on this
repository across sessions. Read it fully at the start of every session,
along with `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/PAYMENTS.md`,
`TASKS.md`, `tests.json`, and recent git history, before making changes.

## Company / Business Context

- Brand: **OnlyLive** (Instagram: @onlylive.ma)
- Business: live events / concerts in Morocco
- OnlyLive legally sells the tickets and receives the money.
- Current real-world event to support: **Tiakola — Casablanca — 05 December
  2026**. Ticket categories: VVIP, VIP, Gradins, across multiple sales
  phases (e.g. "VVIP Early Bird" → "VVIP Phase 1" → ...).
- OnlyLive currently uses third-party ticketing (Webook). Goal: progressively
  build an independent OnlyLive ticketing platform.
- This is a **real commercial application handling money and tickets**.
  Treat security, payment integrity, ticket fraud, concurrency, and
  auditability as critical. This is **not** a toy demo.

## Repository / Git Rules

- Always use the existing repository already available in the session —
  never create a separate repository unless explicitly asked.
- Before doing anything: identify the current repo, run `git status`,
  inspect the current branch, inspect recent commits, fetch/pull the latest
  remote state if safe, and inspect the full project structure.
- Never overwrite or discard existing work.
- Never force-push. Never delete branches. Never reset existing commits.
- Before changing code, report: repository name, current branch, whether
  the working tree is clean, and what was found in the existing project.
- Make incremental commits with clear commit messages when a coherent
  implementation step is complete.
- Never commit: `.env` files, API keys, passwords, payment credentials,
  private keys, production secrets.

## General Working Rules

- Inspect the entire existing repository before major implementation.
  Never assume about code that hasn't been inspected.
- Before major implementation: understand the current repo, identify
  existing architecture, identify risks, create a concrete implementation
  plan, then implement.
- Do not rewrite working code without a reason.
- Avoid unnecessary abstractions and overengineering. Prefer boring, proven
  technology. Use current stable dependency versions.
- Never expose secrets. Never store raw payment card information. Never
  implement a custom card-processing system.

## Technical Direction

- TypeScript, Next.js, PostgreSQL, a mature PostgreSQL ORM, server-side
  validation, responsive web UI, Playwright for critical E2E flows,
  unit/integration tests where appropriate, managed PostgreSQL suitable for
  production, deployment compatible with Vercel or equivalent.
- PostgreSQL is the source of truth.

## Core Domain Model

`User`, `AdminUser`, `Event`, `Venue`, `TicketCategory`, `SalesPhase`,
`Inventory`, `Order`, `OrderItem`, `Reservation`/`Hold`, `Payment`,
`PaymentEvent`, `Ticket`, `TicketScan`, `Refund`, `AuditLog`.

An `Event` has: title, description, images, venue, date/time, sales
opening/closing times, status, several ticket categories, several sales
phases, quantities, prices, purchase limits.

## Critical Inventory Requirement

- It must be **impossible to oversell tickets** under concurrent purchases.
- Use proper PostgreSQL transactions / atomic operations for inventory.
  Never rely on frontend availability counts.
- Implement temporary reservation/hold expiration during checkout.
- Must correctly handle: two people buying the last ticket simultaneously,
  abandoned checkouts, expired reservations, payment success after
  reservation expiration, duplicate payment callbacks, network retries,
  concurrent requests.

## Payment State Machine

- Explicit states, e.g.: `pending`, `awaiting_payment`, `paid`, `failed`,
  `cancelled`, `refunded`, `partially_refunded`.
- Never trust a browser redirect claiming payment success. A ticket may
  only become valid once the **server** has verified payment through a
  trusted provider callback/webhook/API confirmation.
- Payment callbacks must be: authenticated via provider-supported
  signatures, idempotent, logged, replay-resistant, safe when received
  multiple times.
- Never mark an order paid solely from client-side input.
- **No PSP is selected yet.** Implement a clean `PaymentProvider`
  abstraction plus a FAKE/SANDBOX provider for development. Do not invent a
  real PSP API. The real adapter is implemented later from the selected
  provider's official docs, once chosen. Card entry must ultimately go
  through a PCI-DSS compliant Moroccan payment provider's hosted checkout
  or secure equivalent.

## Tickets

- Generated only after confirmed payment.
- Each ticket: immutable unique ID, event, ticket category, order, status,
  cryptographically secure validation token, created timestamp, optional
  attendee info, scan status.
- QR codes must **not** contain sensitive personal data or sequential
  database IDs. The validation token must be unguessable.

## Scanner

- Mobile-first scanner interface/PWA for OnlyLive staff; staff must
  authenticate.
- On scan, server must atomically determine: `VALID`, `ALREADY_USED`,
  `INVALID`, `CANCELLED`, `WRONG_EVENT`.
- Check-in must be atomic so two scanners cannot both admit the same
  ticket concurrently.
- Display: green = accepted, red = rejected, orange = already scanned.
- Record: scanner user, ticket, time, event, result.
- No insecure offline scanning initially.

## Admin

- Dashboard: events, ticket categories, prices, sales phases, inventory,
  orders, payments, refund status, ticket status, check-ins, sales stats,
  CSV export, audit logs.
- Role-based authorization. Customers must never reach admin APIs by
  calling them manually.

## Authentication / Authorization

- Use a mature auth solution. Protect: admin routes, scanner routes,
  customer order info, password reset, sessions, cookies.
- Server-side authorization on every sensitive operation — never rely only
  on hiding frontend UI.

## Security Checklist (minimum)

XSS, CSRF, SQL injection, broken access control, IDOR, SSRF where
applicable, mass assignment, open redirects, rate abuse, credential
stuffing, email enumeration, session fixation, insecure cookies, secret
exposure, webhook forgery, QR forgery, QR replay, duplicate payments,
duplicate refunds.

Use: secure HTTP headers, input validation, rate limiting, structured
logs, safe error messages, environment variables, audit logging.

Never log: passwords, full payment information, authentication tokens,
sensitive secrets.

## Privacy

- Collect the minimum customer information needed. No personal info in QR
  codes.
- Prepare placeholders for: Privacy Policy, Terms & Conditions, Refund
  Policy, Legal Notice. Do **not** invent Moroccan legal requirements —
  clearly mark anything needing review by OnlyLive's accountant/lawyer or
  the payment provider.

## Email

- Transactional emails: order confirmation, payment confirmation, ticket
  delivery, payment failure (where useful), refund confirmation.
- Delivery must be retryable and idempotent — retried email jobs must never
  issue duplicate tickets.

## Ticket Delivery

- Professional, mobile-friendly ticket page. Downloadable PDF if
  practical.
- Ticket displays: OnlyLive, event, venue, date/time, category, ticket
  identifier, QR code.
- QR validity comes from the backend, never from the PDF itself.

## Observability

- Structured application logs, error tracking integration point, health
  endpoint, basic operational metrics, audit log, DB backup strategy
  documentation.

## Testing (mandatory)

Automated tests for dangerous business cases at minimum: two customers
attempting to buy the final ticket, reservation expiration, duplicate
webhook, fake webhook, failed payment, successful payment, payment
callback received twice, ticket generation after payment, attempted ticket
generation before payment, QR forgery, QR scanned twice, same QR scanned
simultaneously by two scanners, cancelled ticket scan, customer accessing
another customer's order, customer accessing admin API, refund state
transitions.

Playwright for important user flows. Never delete or weaken tests simply
to make the build pass.

## Project Memory

Maintain: `CLAUDE.md` (this file), `docs/ARCHITECTURE.md`,
`docs/SECURITY.md`, `docs/PAYMENTS.md`, `TASKS.md`, `tests.json`.

`TASKS.md` tracks: completed / in progress / next / blocked.
`tests.json` tracks critical scenarios and current pass/fail state.

At the start of every future session, recover project state by reading
these files plus git history — do not re-derive from memory alone.

## Implementation Strategy

Work incrementally — never build everything in one uncontrolled change.

First-session scope (in order): inspect repository → propose architecture
→ create project documentation → create database schema → establish
authentication foundation → implement event/catalogue data model →
implement ticket category + sales phase + inventory model → implement
reservation/hold mechanism → implement fake payment provider → implement
the basic customer flow → add automated tests for inventory concurrency
and purchase lifecycle.

Do not implement a real payment provider until one is selected.

At the end of a work session: run all tests, run lint/type checking,
review the git diff, document remaining risks, update `TASKS.md`, update
`tests.json`.

If something is uncertain, explicitly document the uncertainty instead of
inventing an answer.
