# Production database and recovery runbook

## Decision

**Production PostgreSQL target: Neon.**

OnlyLive is deployed on Vercel, and Neon provides pooled Postgres connections,
point-in-time restore/branching, and a native Vercel integration. This is a
good fit for the existing Prisma/PostgreSQL architecture without adding
database features the application does not use.

A connected Neon project named for the ChariPay sandbox does exist, but a
read-only inspection on 2026-09-19 found no application tables in it. It is
therefore **not** treated as proof of which database the current Vercel Preview
uses. The production-provider decision below stands on the target architecture
and recovery capabilities, not on that unverified runtime assumption.

This is a provider decision, **not** permission to create the production
database yet. Production must be a separate Neon project with separate
credentials, billing, recovery settings and Vercel environment variables.

Do not reuse the ChariPay sandbox project as production.

## Recovery objectives

Initial production targets, to be proven by a recovery drill before go-live:

- **RPO target:** no more than 5 minutes of committed business data.
- **RTO target:** restore verified service within 30 minutes.
- **Provider restore window:** at least 7 days of Neon history/PITR.
- **Independent logical backup:** at least once per day, retained for 30 days.

The RPO/RTO numbers are operational targets, not provider guarantees. They
remain unverified until the first timed restore drill succeeds.

The independent logical backup is intentional. Neon PITR protects very well
against bad migrations and application/operator mistakes inside a project, but
a second copy outside the live database account protects against a broader
failure class such as project/account deletion or an unusable provider control
plane.

## Production provisioning gate

Before the first production deployment:

1. Create a **new Neon project** for OnlyLive production. Do not clone or
   repurpose the sandbox project.
2. Choose the Neon region after checking the actual Vercel production compute
   region/latency. Do not copy the sandbox region by assumption.
3. Set the production history/restore window to **at least 7 days** and record
   the resulting recurring cost before enabling it.
4. Protect the production branch against accidental deletion if the selected
   Neon plan supports that control.
5. Generate a dedicated production application role/credential. Never paste
   a connection string into Git, issues, PRs, logs or documentation.
6. Set Vercel Production's `DATABASE_URL` only in encrypted environment
   configuration. Preview must continue using a non-production database.
7. Provision a separate **direct/unpooled** backup connection/credential for
   the trusted backup runner. Do not point `pg_dump` at the serverless
   runtime pooler merely because the application uses it.
8. Run `npm run vercel-build` once against production before accepting
   traffic. A migration failure must block deployment.
9. Configure the independent daily logical backup destination and encryption
   before public sales open.
10. Run and record the restore drill described below.
11. Only after the restore drill and the other go-live gates pass may the
    database task be considered production-ready.

## Runtime and migration connection

OnlyLive currently has one Prisma datasource URL. `prisma migrate deploy`
and runtime Prisma access therefore use the same `DATABASE_URL`.

Neon's pooled connection is compatible with modern Prisma migrations, but this
must still be proven with the exact production project before launch:

```text
npm run vercel-build
```

The build must show `prisma migrate deploy` completing successfully before
`next build`. Do not introduce an unreviewed direct/pooled URL split merely
because older Prisma/Neon guidance required one.

## Layer 1: Neon point-in-time recovery

Use Neon history/PITR as the fastest recovery path for operator error, a bad
migration, or bad application writes.

Recovery procedure:

1. Declare an incident and stop any deployment/migration that may continue
   changing the database.
2. Identify the last known-good timestamp from audit/application/provider
   evidence. Use UTC in the incident record.
3. Restore **to a new recovery branch first** when possible. Do not overwrite
   the current production branch before inspecting the recovered state.
4. Run the post-restore validation below against that isolated branch.
5. Compare the relevant orders/payments/refunds with PSP evidence if the
   incident involves money. Database state alone is not authority for an
   external payment outcome.
6. Once the recovered state is accepted, perform the provider-supported branch
   restore/swap procedure and reconnect Vercel if required by that procedure.
7. Redeploy the exact known-good application commit.
8. Re-run post-restore validation and the critical application smoke tests.
9. Record recovery point, data-loss window, operator, commands/actions and
   validation results in the incident record.

Never "fix" a payment by manually setting an Order or Payment to `paid` during
database recovery. Payment truth must still be reconciled against the PSP.

## Layer 2: independent logical backup

Create a daily custom-format PostgreSQL dump from a trusted operator/backup
runner. Use a **direct/unpooled** Neon connection for this job rather than the
serverless application's pooled runtime connection.

```bash
umask 077
backup_file="onlylive-$(date -u +%Y%m%dT%H%M%SZ).dump"

pg_dump "$BACKUP_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$backup_file"

sha256sum "$backup_file" > "$backup_file.sha256"
```

`BACKUP_DATABASE_URL` is a backup-runner secret, not an application runtime
variable. It should use the direct Neon endpoint and the narrowest role that
has enough privileges to dump the complete application database. Validate
those grants after schema changes.

Requirements:

- encrypt at rest and in transit;
- the backup runner must use a direct/unpooled connection and credentials
  separate from the application runtime credential;
- never upload dumps to GitHub artifacts, the repository, application logs or
  a public bucket;
- keep at least 30 daily restore points initially;
- deletion/retention policy must be explicit and auditable;
- a backup is not considered valid until a restore drill has proved it can be
  read.

The final independent object-storage provider is an infrastructure choice and
can be selected with the production account. The application does not need
that provider's credentials at runtime.

## Restore drill for a logical backup

The drill must use a disposable, isolated Postgres target. Never restore over
the live production database.

Example:

```bash
pg_restore \
  --dbname="$RESTORE_DRILL_DATABASE_URL" \
  --clean \
  --if-exists \
  --no-owner \
  --no-acl \
  onlylive-YYYYMMDDTHHMMSSZ.dump

psql "$RESTORE_DRILL_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f scripts/recovery-smoke.sql
```

Then start the same application commit against the restored database and
exercise, at minimum:

- customer login and ownership-protected order view;
- admin login and read-only order/payment inspection;
- event/category inventory display;
- scanner validation against a dedicated non-production test ticket;
- one read-only reconciliation/status inspection path.

Do **not** send real PSP refunds, mutate live PSP state, or send real customer
email during a restore drill.

Record start/end time. The drill only passes if the measured recovery meets the
RTO target and all invariants/smoke checks pass.

## Post-restore data validation

`scripts/recovery-smoke.sql` is intentionally read-only. Every
`violations` result must be zero.

It checks recovery-critical invariants that should remain true independently of
the application process:

- inventory quantities are non-negative and not oversold;
- every valid ticket belongs to an order in a state compatible with a usable
  ticket;
- ticket event/category identifiers agree with their OrderItem/category;
- payment/order relationships are present;
- the Prisma migrations table exists.

These checks complement the normal test suite; they do not replace PSP
reconciliation or application smoke tests.

## Recovery cadence

Before public sales:

- perform one full restore drill after the production database is provisioned;
- perform another drill after any material database-provider/recovery-policy
  change;
- while OnlyLive is actively selling tickets, perform a recovery drill at
  least quarterly;
- verify daily backups are fresh and checksums present through monitoring or an
  operator checklist.

Any failed or overdue backup/restore check is a production-readiness issue, not
a documentation-only warning.

## Current state

As of 2026-09-19:

- a connected Neon project named for the ChariPay sandbox exists, but currently
  contains no application tables and is not assumed to be Vercel Preview's
  runtime database;
- no separate OnlyLive production Neon project has been provisioned through
  this workflow;
- production recovery objectives have therefore **not** yet been drill-tested.

Do not mark this gate complete until production provisioning and the first
timed restore drill are recorded.