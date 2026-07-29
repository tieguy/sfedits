#!/usr/bin/env bash
#
# Disposable MariaDB for the topic-store tests.
#
# The topic store's value is in its schema and queries - the UNIQUE constraint
# that makes topic dedup work, the M:N join, the GC cascade. Testing that
# against SQLite or a mock would test a different thing, so the tests want a
# real MariaDB. This starts a throwaway one; the database suites report as
# pending when it is not running.
#
# Usage:
#   scripts/test-db.sh start
#   scripts/test-db.sh stop
#   scripts/test-db.sh status

set -euo pipefail

CONTAINER=sfedits-test-db
IMAGE=docker.io/library/mariadb:11
PORT=3307
ROOT_PASSWORD=sfedits-test
DATABASE=sfedits_test

case "${1:-status}" in
  start)
    if podman container exists "$CONTAINER" 2>/dev/null; then
      podman start "$CONTAINER" >/dev/null
    else
      podman run -d \
        --name "$CONTAINER" \
        -e MARIADB_ROOT_PASSWORD="$ROOT_PASSWORD" \
        -e MARIADB_DATABASE="$DATABASE" \
        -p "${PORT}:3306" \
        "$IMAGE" >/dev/null
    fi

    printf 'waiting for mariadb on port %s' "$PORT"
    for _ in $(seq 1 60); do
      if podman exec "$CONTAINER" mariadb-admin ping \
           -uroot -p"$ROOT_PASSWORD" --silent >/dev/null 2>&1; then
        echo " ready"
        echo
        echo "export SFEDITS_TEST_DB='mysql://root:${ROOT_PASSWORD}@127.0.0.1:${PORT}/${DATABASE}'"
        exit 0
      fi
      printf '.'
      sleep 1
    done
    echo " timed out" >&2
    exit 1
    ;;

  stop)
    podman stop "$CONTAINER" >/dev/null 2>&1 || true
    podman rm "$CONTAINER" >/dev/null 2>&1 || true
    echo "stopped and removed $CONTAINER"
    ;;

  status)
    if podman exec "$CONTAINER" mariadb-admin ping \
         -uroot -p"$ROOT_PASSWORD" --silent >/dev/null 2>&1; then
      echo "running on port $PORT"
    else
      echo "not running (start it with: scripts/test-db.sh start)"
      exit 1
    fi
    ;;

  *)
    echo "usage: $0 {start|stop|status}" >&2
    exit 2
    ;;
esac
