#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL no está configurada." >&2
  exit 1
fi
if ! command -v pg_dump >/dev/null 2>&1; then
  echo "pg_dump no está instalado. Instala postgresql-client." >&2
  exit 1
fi

DATA_DIR_RAW="${DATA_DIR:-./data}"
if [[ "$DATA_DIR_RAW" = /* ]]; then DATA_DIR="$DATA_DIR_RAW"; else DATA_DIR="$REPO_ROOT/$DATA_DIR_RAW"; fi
BACKUP_DIR_RAW="${BACKUP_DIR:-$DATA_DIR/backups}"
if [[ "$BACKUP_DIR_RAW" = /* ]]; then BACKUP_DIR="$BACKUP_DIR_RAW"; else BACKUP_DIR="$REPO_ROOT/$BACKUP_DIR_RAW"; fi
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "BACKUP_RETENTION_DAYS debe ser un entero no negativo." >&2
  exit 1
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
umask 077
mkdir -p "$BACKUP_DIR"
OUTPUT="$BACKUP_DIR/nexadesk-$STAMP.dump"

pg_dump --dbname="$DATABASE_URL" --format=custom --file="$OUTPUT"
find "$BACKUP_DIR" -type f -name 'nexadesk-*.dump' -mtime +"$RETENTION_DAYS" -delete
printf 'Backup creado en %s\n' "$OUTPUT"
