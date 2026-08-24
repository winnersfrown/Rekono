#!/usr/bin/env bash
# Provisions throwaway Postgres databases for running the test suite with
# row-level security actually live:
#
#   ./scripts/setup-test-postgres.sh
#   REKONO_TEST_PG_URL=postgres://rekono_app:apppw@127.0.0.1:5432 npm test
#
# The default `npm test` runs on SQLite, which has no row-level security at
# all -- so it exercises every route but proves nothing about the policies.
# This is the run that does.
#
# Two things here matter and are easy to get wrong:
#
#   1. The app role must NOT be a superuser and must not have BYPASSRLS.
#      Postgres skips row security entirely for both, so a suite run as
#      `postgres` would pass while testing nothing.
#   2. The test databases get `rekono.system = 'on'` as a default, which
#      lets the test harness seed fixtures directly through the models
#      (outside any request, where there'd otherwise be no tenant context).
#      Requests still override it per-transaction, so org scoping is still
#      what's under test. A real database must never have this set.
set -euo pipefail

PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
SUPERUSER="${PGSUPERUSER:-postgres}"
APP_ROLE="${REKONO_TEST_ROLE:-rekono_app}"
APP_PASSWORD="${REKONO_TEST_PASSWORD:-apppw}"
WORKERS="${REKONO_TEST_WORKERS:-8}"

psql -h "$PGHOST" -p "$PGPORT" -U "$SUPERUSER" -v ON_ERROR_STOP=1 -q <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$APP_ROLE') THEN
    CREATE ROLE $APP_ROLE LOGIN PASSWORD '$APP_PASSWORD';
  END IF;
END
\$\$;
ALTER ROLE $APP_ROLE NOSUPERUSER NOBYPASSRLS;
SQL

# Jest numbers its workers from 1; worker 0 is the in-band run (--runInBand).
for i in $(seq 0 "$WORKERS"); do
  db="rekono_test_$i"
  psql -h "$PGHOST" -p "$PGPORT" -U "$SUPERUSER" -v ON_ERROR_STOP=1 -q \
    -c "DROP DATABASE IF EXISTS $db;" \
    -c "CREATE DATABASE $db OWNER $APP_ROLE;" \
    -c "ALTER DATABASE $db SET rekono.system = 'on';"
done

echo "Provisioned $((WORKERS + 1)) test databases for role '$APP_ROLE' on $PGHOST:$PGPORT."
echo "Run: REKONO_TEST_PG_URL=postgres://$APP_ROLE:$APP_PASSWORD@$PGHOST:$PGPORT npm test"
