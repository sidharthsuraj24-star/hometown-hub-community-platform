#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL explicitly; this script will not guess or create credentials.}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Read the Supabase migration ledger before touching any migration file. With
# `set -e`, a missing/inaccessible ledger stops the script before any DDL runs.
applied_migrations="$(psql "$SUPABASE_DB_URL" --no-psqlrc --quiet --tuples-only --no-align \
  --set ON_ERROR_STOP=1 \
  --command 'SELECT version FROM supabase_migrations.schema_migrations ORDER BY version')"
if [[ -z "$applied_migrations" ]]; then
  printf '%s\n' 'Migration history is empty; refusing to apply migrations without a recorded baseline.' >&2
  exit 1
fi
for migration in "$ROOT"/supabase/migrations/*.sql; do
  migration_name="$(basename "$migration")"
  case "$(basename "$migration")" in
    004_pandit_onboarding.sql)
      printf '%s\n' 'Skipping already-applied Hometown Hub migration 004_pandit_onboarding.sql (preventing reapplication).'
      continue
      ;;
    005_pandit_storage_uploads.sql)
      printf '%s\n' 'Skipping already-applied Hometown Hub migration 005_pandit_storage_uploads.sql (preventing reapplication).'
      continue
      ;;
    006_pandit_retention_cron_extensions.sql)
      printf '%s\n' 'Skipping already-applied Hometown Hub migration 006_pandit_retention_cron_extensions.sql (preventing reapplication).'
      continue
      ;;
  esac
  migration_version="${migration_name%%_*}"
  if grep -Fxq -- "$migration_version" <<<"$applied_migrations"; then
    printf 'Skipping already-applied migration %s (found in Supabase migration history).\n' "$migration_name"
    continue
  fi
  printf 'Applying %s\n' "$migration_name"
  psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 --file "$migration"
done
printf '%s\n' 'Migration history was checked before applying released migrations; recorded migrations were skipped. Migrations 004, 005, and 006 remain excluded because they are already applied. This script does not seed users, communities, events, or metrics.'
