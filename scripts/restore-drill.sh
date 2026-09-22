#!/usr/bin/env bash
# Restore drill for a logical backup — docs/DATABASE_RECOVERY.md's
# "Restore drill for a logical backup" section.
#
# RESTORE_DRILL_DATABASE_URL must point at a disposable, isolated Postgres
# target that this script is allowed to wipe (--clean). NEVER the live
# production database, NEVER the application's own dev/vitest/e2e
# database. This script will not run without an explicit confirmation
# flag, on top of --clean/--if-exists already being destructive by
# themselves — belt and suspenders, matching this project's established
# pattern for a dangerous default (e.g. ALLOW_FAKE_PAYMENTS_IN_PRODUCTION).
#
# pg_restore --clean only drops objects present in the dump archive itself;
# it does NOT make the target pristine. A reused target can still contain
# leftover objects from a prior run that silently contaminate this drill.
# RESTORE_DRILL_TARGET_IS_FRESH=yes is this script's way of making you
# confirm, each run, that the target was freshly created/emptied first.
#
# A missing .sha256 checksum file refuses the restore by default (fail
# closed); RESTORE_DRILL_ALLOW_UNVERIFIED=yes is the explicit, deliberate
# override for the rare case you accept restoring without verification.
#
# Usage:
#   RESTORE_DRILL_DATABASE_URL="postgresql://..." \
#   RESTORE_DRILL_CONFIRM=yes \
#   RESTORE_DRILL_TARGET_IS_FRESH=yes \
#     scripts/restore-drill.sh path/to/onlylive-YYYYMMDDTHHMMSSZ.dump
set -euo pipefail

dump_file="${1:-}"
if [ -z "$dump_file" ]; then
  echo "Usage: RESTORE_DRILL_DATABASE_URL=... RESTORE_DRILL_CONFIRM=yes $0 <dump-file>" >&2
  exit 1
fi
if [ ! -f "$dump_file" ]; then
  echo "Dump file not found: $dump_file" >&2
  exit 1
fi
# Verify by bare filename from within the dump's own directory, not by full
# path: backup-database.sh hashes the bare filename (from within its output
# directory) precisely so this pair keeps verifying after being copied to
# independent storage or a different host/path. Resolving dump_dir here
# rather than trusting a relative dump_file argument keeps that true
# regardless of the caller's own working directory.
dump_dir="$(cd "$(dirname "$dump_file")" && pwd)"
dump_name="$(basename "$dump_file")"

if [ -f "$dump_dir/$dump_name.sha256" ]; then
  if ! (cd "$dump_dir" && sha256sum -c -- "$dump_name.sha256") 2>&1; then
    echo "Checksum mismatch — refusing to restore a dump that may be corrupted or mismatched" >&2
    exit 1
  fi
elif [ "${RESTORE_DRILL_ALLOW_UNVERIFIED:-}" = "yes" ]; then
  echo "Warning: no .sha256 checksum file found for $dump_file — proceeding unverified because RESTORE_DRILL_ALLOW_UNVERIFIED=yes" >&2
else
  echo "No .sha256 checksum file found for $dump_file — refusing to restore an unverified dump" >&2
  echo "Set RESTORE_DRILL_ALLOW_UNVERIFIED=yes only if you deliberately accept restoring without checksum verification" >&2
  exit 1
fi

if [ -z "${RESTORE_DRILL_DATABASE_URL:-}" ]; then
  echo "RESTORE_DRILL_DATABASE_URL is not set — refusing to run" >&2
  exit 1
fi
if [ "${RESTORE_DRILL_CONFIRM:-}" != "yes" ]; then
  echo "This will WIPE and overwrite every object in the target database (--clean --if-exists)." >&2
  echo "Set RESTORE_DRILL_CONFIRM=yes only once you have confirmed RESTORE_DRILL_DATABASE_URL" >&2
  echo "points at a disposable, isolated target — never production, never a shared dev database." >&2
  exit 1
fi

if [ "${RESTORE_DRILL_TARGET_IS_FRESH:-}" != "yes" ]; then
  echo "RESTORE_DRILL_TARGET_IS_FRESH is not set to 'yes' — refusing to run." >&2
  echo "pg_restore --clean only drops objects present in the dump archive itself; it does" >&2
  echo "NOT guarantee a pristine target. Objects already left over in a reused database from" >&2
  echo "a prior run are not removed and can silently contaminate this drill's result." >&2
  echo "Provision a freshly created/empty database for RESTORE_DRILL_DATABASE_URL (or otherwise" >&2
  echo "independently reset it) before each drill, then set RESTORE_DRILL_TARGET_IS_FRESH=yes." >&2
  exit 1
fi

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Restore drill started: $started_at"

# --exit-on-error: pg_restore's own default is to continue past SQL errors
# and only report an error count at the end. set -e already fails this
# script once pg_restore's final exit code is nonzero, so that default
# isn't a false-green bug, but stopping at the first error is materially
# cleaner for a destructive recovery script. Deliberately not adding
# --single-transaction: PostgreSQL notes it can have locking/resource
# implications for large restores.
pg_restore \
  --dbname="$RESTORE_DRILL_DATABASE_URL" \
  --clean \
  --if-exists \
  --exit-on-error \
  --no-owner \
  --no-acl \
  "$dump_file"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# -d, not a positional connection-string argument: same real bug found
# and fixed in backup-database.sh's pg_dump call -- a bare positional
# connection string ahead of further flags gets silently mishandled on
# Windows/this psql build, here as "additional option ignored" for every
# flag after it, meaning ON_ERROR_STOP and -f were never applied and the
# invariant check silently didn't run at all. Verified with -d locally.
psql -d "$RESTORE_DRILL_DATABASE_URL" \
  -v ON_ERROR_STOP=1 \
  -f "$script_dir/recovery-smoke.sql"

finished_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Restore drill finished: $finished_at"
echo "Record this window, which recovery class was tested, and the smoke/invariant results"
echo "in the incident/drill record per docs/DATABASE_RECOVERY.md's Recovery cadence section."
echo "This script only proves the dump is mechanically restorable and passes read-only"
echo "invariants — it does not replace the application smoke tests docs/DATABASE_RECOVERY.md"
echo "also requires (customer/admin login, inventory display, scanner validation, etc.)."
