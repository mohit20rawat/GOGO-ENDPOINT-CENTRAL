#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# This drill is intentionally restricted to a local disposable CI/test database.
# It refuses managed hosts and any source database other than gogo_test.
: "${POSTGRES_TEST_DATABASE_URL:?Set POSTGRES_TEST_DATABASE_URL to a local disposable gogo_test database URL}"

if ! command -v pg_dump >/dev/null || ! command -v pg_restore >/dev/null || ! command -v psql >/dev/null || ! command -v createdb >/dev/null || ! command -v dropdb >/dev/null; then
  echo "ERROR: PostgreSQL client tools (pg_dump, pg_restore, psql, createdb, dropdb) are required." >&2
  exit 1
fi

# Parse and validate without printing credentials or the connection string.
mapfile -t URL_PARTS < <(node - "$POSTGRES_TEST_DATABASE_URL" <<'NODE'
const raw = process.argv[2];
let u;
try { u = new URL(raw); } catch { console.error("Invalid PostgreSQL URL."); process.exit(2); }
const host = (u.hostname || "").toLowerCase();
const database = decodeURIComponent(u.pathname.replace(/^\//, ""));
if (!["postgres:", "postgresql:"].includes(u.protocol)) {
  console.error("Expected a PostgreSQL connection URL."); process.exit(2);
}
if (!["localhost", "127.0.0.1", "::1"].includes(host)) {
  console.error("Safety stop: backup/restore drill only permits a loopback database host."); process.exit(2);
}
if (database !== "gogo_test") {
  console.error("Safety stop: source database name must be exactly gogo_test."); process.exit(2);
}
const target = new URL(u.toString());
target.pathname = "/gogo_restore_test";
console.log(host);
console.log(database);
console.log(target.toString());
NODE
)
if [[ "${#URL_PARTS[@]}" -ne 3 ]]; then
  echo "ERROR: Could not safely parse the test database URL." >&2
  exit 1
fi
RESTORE_URL="${URL_PARTS[2]}"
TARGET_DB="gogo_restore_test"
BACKUP_FILE="$(mktemp "${TMPDIR:-/tmp}/gogo-postgres-restore.XXXXXX.dump")"
TARGET_CREATED=0

cleanup() {
  status=$?
  rm -f "$BACKUP_FILE"
  if [[ "$TARGET_CREATED" -eq 1 && "${KEEP_RESTORE_DB:-0}" != "1" ]]; then
    dropdb --if-exists --maintenance-db="$POSTGRES_TEST_DATABASE_URL" "$TARGET_DB" >/dev/null 2>&1 || {
      echo "WARNING: Could not automatically remove the disposable restore database." >&2
    }
  fi
  exit "$status"
}
trap cleanup EXIT INT TERM

# Refuse to overwrite an existing database. This drill never drops user-created data.
EXISTS="$(psql "$POSTGRES_TEST_DATABASE_URL" -X -v ON_ERROR_STOP=1 -Atc "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")"
if [[ "$EXISTS" == "1" ]]; then
  echo "Safety stop: $TARGET_DB already exists; refusing to overwrite it." >&2
  exit 1
fi

echo "Creating a custom-format backup from the local disposable test database..."
pg_dump --format=custom --no-owner --no-acl --file="$BACKUP_FILE" "$POSTGRES_TEST_DATABASE_URL"
test -s "$BACKUP_FILE"

echo "Creating an isolated restore database..."
createdb --maintenance-db="$POSTGRES_TEST_DATABASE_URL" "$TARGET_DB"
TARGET_CREATED=1
pg_restore --exit-on-error --no-owner --no-acl --dbname="$RESTORE_URL" "$BACKUP_FILE"

echo "Checking restored migration ledger and required tables..."
psql "$RESTORE_URL" -X -v ON_ERROR_STOP=1 -At <<'SQL'
DO $$
DECLARE
  migration_count integer;
  missing_tables text;
BEGIN
  IF to_regclass('public.schema_migrations') IS NULL THEN
    RAISE EXCEPTION 'Restore verification failed: schema_migrations is missing';
  END IF;

  SELECT count(*) INTO migration_count FROM public.schema_migrations;
  IF migration_count < 2 THEN
    RAISE EXCEPTION 'Restore verification failed: expected at least two recorded migrations, found %', migration_count;
  END IF;

  SELECT string_agg(required.name, ', ')
    INTO missing_tables
    FROM (VALUES ('tenants'), ('users'), ('devices'), ('audit_events'), ('device_alerts')) AS required(name)
   WHERE to_regclass('public.' || required.name) IS NULL;

  IF missing_tables IS NOT NULL THEN
    RAISE EXCEPTION 'Restore verification failed: missing required tables: %', missing_tables;
  END IF;
END $$;
SELECT 'PASS: backup restored; migration ledger and required tables verified';
SQL

echo "PASS: PostgreSQL backup/restore drill completed."
if [[ "${KEEP_RESTORE_DB:-0}" == "1" ]]; then
  echo "The disposable restore database is being kept because KEEP_RESTORE_DB=1."
fi
