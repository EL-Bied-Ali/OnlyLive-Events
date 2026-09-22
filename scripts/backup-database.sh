#!/usr/bin/env bash
# Independent logical backup — docs/DATABASE_RECOVERY.md's "Layer 2".
#
# Run by a trusted backup operator/runner, never by the application at
# runtime. BACKUP_DATABASE_URL must be a direct/unpooled Neon connection
# using the narrowest role that can dump the whole application database —
# never the serverless app's pooled runtime connection string.
#
# Usage:
#   BACKUP_DATABASE_URL="postgresql://..." \
#   BACKUP_OUTPUT_DIR="/path/to/backups" \
#     scripts/backup-database.sh
set -euo pipefail

if [ -z "${BACKUP_DATABASE_URL:-}" ]; then
  echo "BACKUP_DATABASE_URL is not set — refusing to run" >&2
  exit 1
fi

umask 077

output_dir="${BACKUP_OUTPUT_DIR:-.}"
mkdir -p "$output_dir"

backup_file="$output_dir/onlylive-$(date -u +%Y%m%dT%H%M%SZ).dump"

# -d (not a positional connection-string argument): confirmed on
# Windows/this pg_dump build, passing the connection string as a bare
# positional argument alongside --format=custom-style long flags fails
# with a confusing "too many command-line arguments" error that
# misattributes the failure to the flag itself, not the connection
# string. -d avoids that ambiguity entirely and works identically on
# Linux (CI/production operators) -- verified both ways locally.
pg_dump -d "$BACKUP_DATABASE_URL" \
  --format=custom \
  --no-owner \
  --no-acl \
  --file="$backup_file"

sha256sum "$backup_file" > "$backup_file.sha256"

echo "Backup written: $backup_file"
echo "Checksum:        $backup_file.sha256"

# A backup file existing is not the same as a backup being restorable.
# docs/DATABASE_RECOVERY.md: "a backup is not considered valid until a
# restore drill has proved it can be read." Run scripts/restore-drill.sh
# against this exact file before trusting it.
