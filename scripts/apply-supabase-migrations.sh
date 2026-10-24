#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL explicitly; this script will not guess or create credentials.}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  # Migration 004 is already applied to Hometown Hub production; keep it excluded
  # to prevent accidental reapplication. Future schema work needs a new migration.
  if [[ "$(basename "$migration")" == '004_pandit_onboarding.sql' ]]; then
    printf '%s\n' 'Skipping already-applied Hometown Hub migration 004_pandit_onboarding.sql (preventing reapplication).'
    continue
  fi
  printf 'Applying %s\n' "$(basename "$migration")"
  psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 --file "$migration"
done
printf '%s\n' 'Released migrations applied; migration 004 remains skipped because it is already applied to Hometown Hub production. This script does not seed users, communities, events, or metrics.'
