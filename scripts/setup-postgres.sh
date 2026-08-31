#!/usr/bin/env bash
set -Eeuo pipefail

DB_NAME="${NEXADESK_DB_NAME:-nexadesk}"
DB_USER="${NEXADESK_DB_USER:-nexa}"
DB_PORT="${NEXADESK_DB_PORT:-5432}"
DB_PASSWORD="${NEXADESK_DB_PASSWORD:-}"
ROTATE_PASSWORD="${NEXADESK_ROTATE_PASSWORD:-false}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SCHEMA_FILE="$REPO_ROOT/postgres/schema.sql"
ENV_FILE="${NEXADESK_ENV_FILE:-$REPO_ROOT/.env}"

if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "No encuentro el esquema PostgreSQL: $SCHEMA_FILE" >&2
  exit 1
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

if ! sudo systemctl is-active --quiet postgresql 2>/dev/null; then
  sudo systemctl enable --now postgresql
fi
if ! sudo systemctl is-active --quiet postgresql 2>/dev/null; then
  echo "El servicio PostgreSQL del sistema no está activo." >&2
  echo "Si usas Docker, configura ese contenedor por separado; no mezclo sus credenciales automáticamente." >&2
  exit 1
fi

ROLE_EXISTS="$(sudo -u postgres psql -AtX -v ON_ERROR_STOP=1 --set=db_user="$DB_USER" -c "SELECT 1 FROM pg_roles WHERE rolname = :'db_user'")"
PASSWORD_AVAILABLE=false

if [[ "$ROLE_EXISTS" == "1" ]]; then
  if [[ "$ROTATE_PASSWORD" == "true" ]]; then
    if [[ -z "$DB_PASSWORD" ]]; then
      echo "NEXADESK_ROTATE_PASSWORD=true requiere NEXADESK_DB_PASSWORD." >&2
      exit 1
    fi
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
      --set=db_user="$DB_USER" \
      --set=db_password="$DB_PASSWORD" <<'SQL'
SELECT format('ALTER ROLE %I WITH LOGIN PASSWORD %L', :'db_user', :'db_password')\gexec
SQL
    PASSWORD_AVAILABLE=true
    echo "Contraseña del rol actualizada por rotación explícita."
  else
    echo "El rol PostgreSQL ya existe; conservo su contraseña."
    [[ -n "$DB_PASSWORD" ]] && PASSWORD_AVAILABLE=true
  fi
else
  if [[ -z "$DB_PASSWORD" ]]; then
    if ! command -v openssl >/dev/null 2>&1; then
      echo "Falta openssl para generar la contraseña inicial." >&2
      exit 1
    fi
    DB_PASSWORD="$(openssl rand -hex 24)"
  fi
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    --set=db_user="$DB_USER" \
    --set=db_password="$DB_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I LOGIN PASSWORD %L', :'db_user', :'db_password')\gexec
SQL
  PASSWORD_AVAILABLE=true
fi

DB_EXISTS="$(sudo -u postgres psql -AtX -v ON_ERROR_STOP=1 --set=db_name="$DB_NAME" -c "SELECT 1 FROM pg_database WHERE datname = :'db_name'")"
if [[ "$DB_EXISTS" != "1" ]]; then
  sudo -u postgres psql -v ON_ERROR_STOP=1 \
    --set=db_name="$DB_NAME" \
    --set=db_user="$DB_USER" <<'SQL'
SELECT format('CREATE DATABASE %I OWNER %I', :'db_name', :'db_user')\gexec
SQL
else
  DB_OWNER="$(sudo -u postgres psql -AtX -v ON_ERROR_STOP=1 --set=db_name="$DB_NAME" -c "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = :'db_name'")"
  if [[ "$DB_OWNER" != "$DB_USER" ]]; then
    echo "La base $DB_NAME ya existe y pertenece a $DB_OWNER, no a $DB_USER." >&2
    echo "Usa NEXADESK_DB_NAME para una base nueva; no la sobrescribo." >&2
    exit 1
  fi
fi

sudo -u postgres psql -v ON_ERROR_STOP=1 -1 -d "$DB_NAME" -f "$SCHEMA_FILE" >/dev/null

write_database_url() {
  local target="$1"
  local url="$2"
  local tmp
  umask 077
  mkdir -p "$(dirname -- "$target")"
  tmp="$(mktemp "${target}.tmp.XXXXXX")"
  if [[ -f "$target" ]]; then
    awk -v value="$url" 'BEGIN { replaced=0 } /^DATABASE_URL=/ { if (!replaced) { print "DATABASE_URL=" value; replaced=1 } next } { print } END { if (!replaced) print "DATABASE_URL=" value }' "$target" > "$tmp"
  else
    printf 'DATABASE_URL=%s\n' "$url" > "$tmp"
  fi
  chmod 600 "$tmp"
  mv -f "$tmp" "$target"
}

if [[ "$PASSWORD_AVAILABLE" == "true" ]]; then
  CONNECTION_URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$DB_PORT/$DB_NAME?sslmode=disable"
  write_database_url "$ENV_FILE" "$CONNECTION_URL"
  chmod 600 "$ENV_FILE"
  printf '\nPostgreSQL preparado y DATABASE_URL guardada en %s.\n' "$ENV_FILE"
else
  printf '\nEsquema PostgreSQL aplicado en %s.\n' "$DB_NAME"
  printf 'No sobrescribí DATABASE_URL porque conservé la contraseña existente.\n'
fi
printf 'Después ejecuta: npm run db:test\n'
