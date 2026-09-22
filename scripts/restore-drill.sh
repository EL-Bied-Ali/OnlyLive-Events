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
# Usage:
#   RESTORE_DRILL_DATABASE_URL="postgresql://..." \
#   RESTORE_DRILL_CONFIRM=yes \
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
if [ -f "$dump_file.sha256" ]; then
  if ! sha256sum -c "$dump_file.sha256" 2>&1; then
    echo "Checksum mismatch — refusing to restore a dump that may be corrupted or tampered with" >&2
    exit 1
  fi
else
  echo "Warning: no .sha256 checksum file found for $dump_file — cannot verify integrity" >&2
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

started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "Restore drill started: $started_at"

pg_restore \
  --dbname="$RESTORE_DRILL_DATABASE_URL" \
  --clean \
  --if-exists \
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
