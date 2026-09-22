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

Initial production targets, to be proven by recovery drills before go-live:

- **Primary recovery (Neon PITR):** RPO <= 5 minutes and RTO <= 30 minutes.
- **Provider/account-loss fallback (independent logical backup):** RPO <= 24
  hours and initial RTO <= 4 hours.
- **Provider restore window:** at least 7 days of Neon history/PITR.
- **Independent logical backup:** at least once per day, retained for 30 days.

These are operational objectives, not provider guarantees. The primary and
independent-backup targets cover different failure classes; the daily logical
backup does not provide a five-minute RPO if the Neon project/account itself is
unavailable. All targets remain unverified until timed restore drills succeed.

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

`scripts/backup-database.sh` implements this exactly, and has been run
end-to-end against a real (throwaway, local) Postgres cluster — a bare
positional connection string ahead of `--format=custom`-style flags is
mishandled by at least one real `pg_dump` build (confirmed 2026-09-22,
Windows), so the script explicitly uses `-d "$BACKUP_DATABASE_URL"` rather
than a positional argument:

```bash
BACKUP_DATABASE_URL="postgresql://..." \
BACKUP_OUTPUT_DIR="/path/to/backups" \
  scripts/backup-database.sh
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

`scripts/restore-drill.sh` implements this exactly, refuses to run without an
explicit `RESTORE_DRILL_CONFIRM=yes`, and verifies the dump's checksum before
touching anything — a missing `.sha256` file **fails closed** (refuses to
restore) unless the operator deliberately overrides it with
`RESTORE_DRILL_ALLOW_UNVERIFIED=yes`. Run end-to-end against a real
(throwaway, local) Postgres cluster on 2026-09-22, which is also where the
`pg_dump` bug above was found — the same bug affects `psql`'s positional
connection-string form here too: without the script's `-d` fix,
`ON_ERROR_STOP`/`-f` are silently ignored and the invariant check never
actually runs, with no visible error.

`pg_restore --clean` only drops objects present in the dump archive itself —
it does **not** guarantee a pristine target, so a target reused across runs
can retain leftover objects that silently contaminate the drill's result
(flagged in GPT's audit of PR #69, citing PostgreSQL's own `pg_restore`
documentation). The script therefore also refuses to run unless
`RESTORE_DRILL_TARGET_IS_FRESH=yes` is set, which is this project's way of
making the operator explicitly confirm, every run, that the target database
was freshly created or independently reset beforehand — never solved by
adding `pg_restore --create`, since that changes required privileges and
database-naming semantics.

```bash
RESTORE_DRILL_DATABASE_URL="postgresql://..." \
RESTORE_DRILL_CONFIRM=yes \
RESTORE_DRILL_TARGET_IS_FRESH=yes \
  scripts/restore-drill.sh onlylive-YYYYMMDDTHHMMSSZ.dump
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

Record start/end time. Record which recovery class is being tested. The drill
only passes if the measured recovery meets that class's RTO target and all
invariants/smoke checks pass.

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

CI runs this file immediately after migrations against the freshly migrated,
empty Vitest database. That continuously validates the SQL syntax, table/enum
names and migration-table assumptions without depending on test fixtures. This
CI check is not a restore drill and does not prove backup readability.

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

**Update, 2026-09-22:** `scripts/backup-database.sh` and
`scripts/restore-drill.sh` now exist and were run end-to-end against a real
(throwaway, local, non-application) Postgres cluster: dump → checksum →
`--clean` restore → `recovery-smoke.sql` invariant check, using the scripts'
own safety guard (`RESTORE_DRILL_CONFIRM=yes`) rather than bypassing it. This
found and fixed two real bugs the original inline command examples had (a
positional connection-string argument silently mishandled by at least one
real `pg_dump`/`psql` build on Windows — see both sections above). This
proves the **mechanics** of the backup/restore pipeline and the invariant
check actually work; it is explicitly **not** the real production restore
drill this gate requires — that still needs the actual production Neon
project, its real PITR/backup behavior, and the application smoke tests
listed above, none of which a throwaway local cluster can stand in for.

**Update, 2026-09-22 (independent audit fixes):** an independent cold audit of
the PR adding these scripts (GPT, reviewing before merge) found and confirmed
three real gaps, all fixed and re-verified end-to-end against the same
throwaway local cluster before merging:

- both scripts were committed with git mode `100644` (non-executable), which
  would fail with `Permission denied` when the docs' own examples invoke them
  directly on a normal Linux runner — fixed to `100755`;
- `restore-drill.sh`'s checksum check only warned and proceeded when
  `<dump>.sha256` was missing, contradicting this document's own "verifies the
  dump's checksum before restoring" claim — changed to fail closed by default,
  re-verified locally that a missing checksum now refuses with exit 1, with
  `RESTORE_DRILL_ALLOW_UNVERIFIED=yes` as the sole, explicit override;
- `pg_restore --clean` does not guarantee a pristine target (it only drops
  objects present in the dump archive itself, per PostgreSQL's own
  documentation) — the script now also refuses to run unless
  `RESTORE_DRILL_TARGET_IS_FRESH=yes`, re-verified locally that this refuses
  by default and that a genuinely fresh target proceeds.

`umask 077` was also reordered to run before `mkdir -p "$output_dir"` in
`backup-database.sh`, so a newly created backup directory cannot inherit a
looser ambient umask.

**Update, 2026-09-22 (second audit pass — checksum portability):** the same
independent reviewer then caught a fourth real gap in the fix above:
`sha256sum` was hashing the dump's full path, not its bare filename. Since
these backups are specifically meant to leave the machine that created them,
a checksum file recorded against a path like
`/var/backups/onlylive-....dump` would fail to verify once the `.dump`/
`.sha256` pair was copied to independent storage or a different host/path —
even though the dump bytes were perfectly intact. Fixed by having
`backup-database.sh` hash the bare filename from within its output directory,
and `restore-drill.sh` verify by bare filename from within the dump's own
directory (resolved from the dump path actually given, not assumed to be the
caller's working directory). Re-verified end-to-end: created a backup in one
directory, copied the `.dump`/`.sha256` pair to a second directory, deleted
the first directory entirely, and confirmed `restore-drill.sh` still verifies
and restores correctly from the copy.

Also added `pg_restore --exit-on-error` (its own default is to continue past
SQL errors and only report a count afterward; `set -e` already fails this
script on `pg_restore`'s final nonzero exit, so this isn't a false-green fix,
but stopping at the first error is materially cleaner for a destructive
recovery script) and softened the checksum-mismatch message from "corrupted
or tampered with" to "corrupted or mismatched", since a plain SHA-256 file
next to the dump protects against accidental corruption/mismatch, not a
malicious actor capable of replacing both files.

Do not mark this gate complete until production provisioning and the first
timed restore drill against the real production database are recorded.
