# OnlyLive Events

Independent ticketing platform for OnlyLive live events in Morocco.
First-session scope, architecture decisions, and remaining work are
tracked in `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`,
`docs/PAYMENTS.md`, `TASKS.md`, and `tests.json` — read those before
making changes.

## Setup

```bash
npm install
cp .env.example .env   # fill in generated secrets, see comments in the file

sudo service postgresql start   # or however Postgres runs in your environment
npx prisma migrate deploy       # apply migrations to $DATABASE_URL
npm run seed                    # seeds the Tiakola event + an admin user

npm run dev
```

## Scripts

- `npm run dev` / `npm run build` / `npm run start`
- `npm run lint` / `npm run typecheck`
- `npm test` — Vitest unit + integration tests (needs `TEST_DATABASE_URL`,
  a separate database from `DATABASE_URL`)
- `npm run test:e2e` — Playwright, against a running build
- `npm run seed` — seeds the Tiakola event and a `super_admin` AdminUser
  (`admin@onlylive.ma` / `ChangeMe123!` in dev — change immediately
  outside local development)
