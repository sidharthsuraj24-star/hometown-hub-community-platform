#!/usr/bin/env bash
set -euo pipefail

: "${SUPABASE_DB_URL:?Set SUPABASE_DB_URL explicitly; this script will not guess or create credentials.}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
for migration in "$ROOT"/supabase/migrations/*.sql; do
  printf 'Applying %s\n' "$(basename "$migration")"
  psql "$SUPABASE_DB_URL" --set ON_ERROR_STOP=1 --file "$migration"
done
printf '%s\n' 'Migrations applied. This script does not seed users, communities, events, or metrics.'
