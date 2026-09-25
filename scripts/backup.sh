#!/usr/bin/env bash
# Nightly backup of the application database (not n8n's own database).
#   DATABASE_URL=... BACKUP_DIR=/var/backups/wa-support KEEP_DAYS=14 scripts/backup.sh
# Writes a compressed custom-format dump, verifies it can be listed, prunes old
# dumps and records the result in app.health_checks (component 'backup').
set -euo pipefail
: "${DATABASE_URL:?DATABASE_URL is required}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
file="$BACKUP_DIR/wa_support-$stamp.dump"

status=ok
detail="{}"
if pg_dump --format=custom --no-owner --file="$file" "$DATABASE_URL" && pg_restore --list "$file" >/dev/null; then
  chmod 600 "$file"
  size=$(stat -c %s "$file")
  detail=$(printf '{"file":"%s","bytes":%s}' "$(basename "$file")" "$size")
  find "$BACKUP_DIR" -name 'wa_support-*.dump' -mtime +"$KEEP_DAYS" -delete
else
  status=error
  rm -f "$file"
fi
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c \
  "SELECT app.record_health('backup', '$status', '$detail'::jsonb)" >/dev/null || true
[ "$status" = ok ] && echo "backup ok: $file" || { echo "backup FAILED" >&2; exit 1; }
