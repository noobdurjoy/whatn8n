#!/usr/bin/env bash
# Restore a dump into an EMPTY database (e.g. a fresh wa_support created by
# db/roles.sql). Stop the app and deactivate the n8n workflows first.
#   DATABASE_URL=postgresql://wa_app:...@host/wa_support scripts/restore.sh backups/wa_support-....dump
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
dump="${1:?usage: restore.sh <dump-file>}"
tables=$(psql "$DATABASE_URL" -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'app'")
if [ "$tables" != "0" ]; then
  echo "Refusing to restore: schema app already has $tables tables. Restore into an empty database." >&2
  exit 1
fi
pg_restore --no-owner --exit-on-error --dbname="$DATABASE_URL" "$dump"
# Re-apply grants for the n8n role (functions are recreated by the restore).
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -f db/grants.sql
# Safety after a restore: automatic sending stays off until an owner re-enables it.
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c "UPDATE app.settings SET value = 'false'::jsonb WHERE key = 'ai_enabled'"
echo "restore complete; AI answering is OFF — re-enable it in the dashboard after checking."
