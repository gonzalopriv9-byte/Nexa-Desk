#!/usr/bin/env bash
set -Eeuo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL no está configurada." >&2
  exit 1
fi

DATA_DIR="${DATA_DIR:-./data}"
BACKUP_DIR="${BACKUP_DIR:-$DATA_DIR/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

pg_dump --dbname="$DATABASE_URL" --format=custom --file="$BACKUP_DIR/nexadesk-$STAMP.dump"
find "$BACKUP_DIR" -type f -name 'nexadesk-*.dump' -mtime +"$RETENTION_DAYS" -delete
printf 'Backup creado: %s\n' "$BACKUP_DIR/nexadesk-$STAMP.dump"
