#!/usr/bin/env bash
set -Eeuo pipefail

DB_NAME="${NEXADESK_DB_NAME:-nexadesk}"
DB_USER="${NEXADESK_DB_USER:-nexa}"
DB_PASSWORD="${NEXADESK_DB_PASSWORD:-}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_FILE="$SCRIPT_DIR/../postgres/schema.sql"

if [[ -z "$DB_PASSWORD" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    DB_PASSWORD="$(openssl rand -hex 24)"
  else
    DB_PASSWORD="$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 48)"
  fi
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo es necesario para instalar y configurar PostgreSQL." >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "Instalando PostgreSQL..."
  sudo apt-get update
  sudo apt-get install -y postgresql postgresql-client
fi

sudo systemctl enable --now postgresql

sudo -u postgres psql -v ON_ERROR_STOP=1 \
  --set=db_user="$DB_USER" \
  --set=db_password="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password')
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = :'db_user')\gexec
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'db_user', :'db_password')\gexec
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 \
  --set=db_name="$DB_NAME" \
  --set=db_user="$DB_USER" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = :'db_name')\gexec
SQL

sudo -u postgres psql -v ON_ERROR_STOP=1 -d "$DB_NAME" -f "$SCHEMA_FILE"

CONNECTION_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:5432/$DB_NAME?sslmode=disable"
printf '\nPostgreSQL local preparado para NexaDesk.\n'
printf 'Añade esta variable a /home/pi/Nexa-Desk-Nuevo/.env (no la publiques):\n\n'
printf 'DATABASE_URL=%s\n' "$CONNECTION_URL"
printf '\nDespués ejecuta: npm run db:test\n'
