#!/bin/bash
# Poll the fork for new commits and redeploy on Toolforge if the branch moved.
#
# This is the Toolforge analogue of deploy.sh (which targets the droplet).
# It is a *poller*, not a webhook: no inbound endpoint, no credentials stored
# off-Toolforge. Safe to run either way:
#
#   from a bastion:  become sfedits && ./scripts/toolforge-autoupdate.sh
#   as a job:        toolforge jobs load toolforge-jobs.yaml  (see that file)
#
# Behaviour:
#   1. git ls-remote the tracked branch
#   2. if the SHA matches the last deployed SHA, exit 0 silently
#   3. otherwise build, wait for the build, then restart the bot job
#   4. record the SHA only after the restart succeeds
#
# A failed build or restart leaves the recorded SHA untouched, so the next
# tick retries. Failures alert through the same path as healthcheck.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

REPO_URL="${SFEDITS_DEPLOY_REPO:-https://github.com/tieguy/sfedits.git}"
BRANCH="${SFEDITS_DEPLOY_BRANCH:-integration}"
BOT_JOB="${SFEDITS_BOT_JOB:-bot}"
# The webservice is not optional any more: public/server.js serves the /create
# form, so a deploy that only restarts the bot ships new bot code against an old
# form. Set to "no" to deploy the bot alone.
RESTART_WEBSERVICE="${SFEDITS_RESTART_WEBSERVICE:-yes}"

# Schema migrations run on the freshly built image before the restart. Set to
# "no" only to debug a deploy; skipping them ships code against an old schema.
RUN_MIGRATIONS="${SFEDITS_RUN_MIGRATIONS:-yes}"
MIGRATE_JOB="${SFEDITS_MIGRATE_JOB:-migrate}"
MIGRATE_TIMEOUT="${SFEDITS_MIGRATE_TIMEOUT:-600}"   # seconds, API mode only
IMAGE="${SFEDITS_IMAGE:-tool-san-francisco-edit-stream/tool-san-francisco-edit-stream:latest}"

# In build-service containers $HOME is not the tool's NFS home (mount=all puts
# it at /data/project/<tool>, exposed as $TOOL_DATA_DIR). $HOME remains the
# fallback for bastion runs, where the two coincide.
STATE_DIR="${SFEDITS_STATE_DIR:-${TOOL_DATA_DIR:-$HOME}/data}"
SHA_FILE="$STATE_DIR/deployed-sha"
LOCK_FILE="$STATE_DIR/autoupdate.lock"
BUILD_TIMEOUT="${SFEDITS_BUILD_TIMEOUT:-900}"   # seconds

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

# The buildpack launcher puts node on PATH for direct process types (`bot: node
# page-watch.js`), but this job runs a shell script and gets an environment
# without it — `node: command not found` on the 2026-08-02 deploy. That failure
# surfaced as a missing /changelog entry, but the same gap silently disables
# alert() below, which is the part that matters. Resolve the interpreter once,
# by search, so neither call site depends on PATH.
find_node() {
  if command -v node 2>/dev/null; then
    return 0
  fi
  local candidate
  for candidate in /layers/*/*/bin/node /layers/*/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -x "$candidate" ]; then
      echo "$candidate"
      return 0
    fi
  done
  return 1
}
NODE="$(find_node || true)"

alert() {
  local msg="$1"
  log "ALERT: $msg"
  # send-alert.js reads config.json the same way the bot does; if it is
  # unavailable we still want the non-zero exit for the job's failure email.
  if [ -z "$NODE" ]; then
    log "(no node interpreter found; relying on job failure email)"
    return 0
  fi
  "$NODE" "$SCRIPT_DIR/send-alert.js" "sfedits autoupdate: $msg" || \
    log "(send-alert.js failed; relying on job failure email)"
}

mkdir -p "$STATE_DIR"

# Single-flight. A build can outlast the schedule interval; overlapping runs
# would race on SHA_FILE and could restart the bot mid-build.
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  log "another autoupdate run holds the lock; skipping this tick"
  exit 0
fi

# --- toolforge access --------------------------------------------------
#
# Bastions have the toolforge CLI; build-service job containers do not (no
# CLI, no kubectl, no python — verified 2026-08-02 via `webservice shell`).
# What those containers do have is node and, with mount=all, the tool's TLS
# client certs in .toolskube. Prefer the CLI where it exists; otherwise
# drive the same API gateway through scripts/toolforge-api.js.
TF_CERT_DIR="${TOOL_DATA_DIR:-$HOME}/.toolskube"
if command -v toolforge >/dev/null 2>&1; then
  TF_MODE=cli
elif [ -f "$TF_CERT_DIR/client.crt" ] && [ -n "$NODE" ]; then
  TF_MODE=api
else
  alert "no toolforge CLI, and no client certs + node for API access"
  exit 1
fi
log "toolforge access: $TF_MODE"

tf_api() { "$NODE" "$SCRIPT_DIR/toolforge-api.js" "$@"; }

tf_build_start() {
  if [ "$TF_MODE" = cli ]; then toolforge build start --ref "$BRANCH" "$REPO_URL"
  else tf_api build-start "$REPO_URL" "$BRANCH"; fi
}

# One status line per call; the polling loop pattern-matches it. CLI prints
# "Status: ok" style, the API prints raw states like BUILD_SUCCESS — the
# case patterns below cover both.
tf_build_status() {
  if [ "$TF_MODE" = cli ]; then toolforge build show 2>/dev/null | grep -iE '^\s*status' | head -1 || true
  else tf_api build-status 2>/dev/null || true; fi
}

tf_migrate_delete() {
  if [ "$TF_MODE" = cli ]; then toolforge jobs delete "$MIGRATE_JOB" >/dev/null 2>&1
  else tf_api job-delete "$MIGRATE_JOB" >/dev/null 2>&1; fi
}

tf_migrate_run() {
  if [ "$TF_MODE" = cli ]; then toolforge jobs run "$MIGRATE_JOB" --command "$MIGRATE_JOB" --image "$IMAGE" --wait
  else tf_api job-run-wait "$MIGRATE_JOB" "$MIGRATE_JOB" "$IMAGE" "$MIGRATE_TIMEOUT"; fi
}

tf_migrate_logs() {
  if [ "$TF_MODE" = cli ]; then toolforge jobs logs "$MIGRATE_JOB" 2>/dev/null
  else tf_api job-logs "$MIGRATE_JOB" 2>/dev/null; fi
}

tf_bot_restart() {
  if [ "$TF_MODE" = cli ]; then toolforge jobs restart "$BOT_JOB"
  else tf_api job-restart "$BOT_JOB"; fi
}

tf_webservice_restart() {
  if [ "$TF_MODE" = cli ]; then toolforge webservice restart
  else tf_api webservice-restart; fi
}

# Not fatal — the deploy itself is all toolforge CLI calls, and refusing to ship
# over a missing changelog would be worse than shipping without one. But it does
# mean alert() is reduced to the job's failure email, so say so once per tick
# rather than leaving it to be inferred from a later fallback line.
[ -n "$NODE" ] || log "WARNING: no node interpreter found; alerts and /changelog are degraded this run"

REMOTE_SHA="$(git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | awk '{print $1}')"
if [ -z "$REMOTE_SHA" ]; then
  alert "could not resolve $BRANCH on $REPO_URL"
  exit 1
fi

DEPLOYED_SHA=""
[ -f "$SHA_FILE" ] && DEPLOYED_SHA="$(cat "$SHA_FILE")"

if [ "$REMOTE_SHA" = "$DEPLOYED_SHA" ]; then
  log "up to date at ${REMOTE_SHA:0:8}"
  exit 0
fi

log "deploying $BRANCH: ${DEPLOYED_SHA:0:8}${DEPLOYED_SHA:+ -> }${REMOTE_SHA:0:8}"

# --- build -------------------------------------------------------------

if ! tf_build_start; then
  alert "build failed to start for ${REMOTE_SHA:0:8}"
  exit 1
fi

# Poll rather than trusting a --wait flag; `build show` is the stable surface.
DEADLINE=$(( $(date +%s) + BUILD_TIMEOUT ))
while :; do
  if [ "$(date +%s)" -ge "$DEADLINE" ]; then
    alert "build for ${REMOTE_SHA:0:8} still running after ${BUILD_TIMEOUT}s"
    exit 1
  fi
  sleep 20
  STATUS="$(tf_build_status)"
  case "$(echo "$STATUS" | tr '[:upper:]' '[:lower:]')" in
    *ok*|*success*|*complete*) log "build succeeded"; break ;;
    *fail*|*error*|*cancel*|*timeout*)
      alert "build failed for ${REMOTE_SHA:0:8} (toolforge build logs)"
      exit 1 ;;
    *) log "build in progress..." ;;
  esac
done

# --- migrate -----------------------------------------------------------
#
# On the image that was just built, so the migrations that ship with the new
# code are the ones applied. BEFORE the restart, deliberately: new code must
# never meet an old schema, and the reverse is survivable because migrations are
# additive (CREATE TABLE IF NOT EXISTS) - the still-running old code tolerates
# the new schema for the seconds until the restart.
#
# scripts/migrate.js is idempotent, so this runs on every deploy rather than
# only on deploys that add a migration. One cheap query, and no chance of
# forgetting which deploy was the one that needed it.
if [ "$RUN_MIGRATIONS" = "yes" ]; then
  log "applying migrations"
  # `jobs run` refuses a name that already exists, and the previous deploy's
  # finished job still holds the name.
  tf_migrate_delete || true

  if ! tf_migrate_run; then
    tf_migrate_logs | tail -20 || true
    alert "migrations failed for ${REMOTE_SHA:0:8}; not restarting"
    exit 1
  fi

  # The exit status of a --wait job is not always the migration's own status,
  # so surface the output either way; migrate.js prints what it applied.
  tf_migrate_logs | tail -5 || true
fi

# --- restart -----------------------------------------------------------

# Not a rolling swap: this drops the EventStreams connection. The bot resumes
# from its own state on start, so the window is a gap in coverage, not data
# loss — but it is why this runs on a schedule rather than on every push.
log "restarting job $BOT_JOB"
if ! tf_bot_restart; then
  alert "built ${REMOTE_SHA:0:8} but failed to restart $BOT_JOB"
  exit 1
fi

if [ "$RESTART_WEBSERVICE" = "yes" ]; then
  log "restarting webservice"
  tf_webservice_restart || alert "webservice restart failed after ${REMOTE_SHA:0:8}"
fi

echo "$REMOTE_SHA" > "$SHA_FILE"

# Best-effort: append this deploy (with its PR titles, via the GitHub
# compare API) to the changelog the webservice serves at /changelog. A
# GitHub API hiccup must not fail a deploy that already succeeded.
if [ -n "$NODE" ]; then
  SFEDITS_STATE_DIR="$STATE_DIR" SFEDITS_DEPLOY_REPO="$REPO_URL" \
    "$NODE" "$SCRIPT_DIR/record-deploy.js" "$DEPLOYED_SHA" "$REMOTE_SHA" || \
    log "record-deploy failed; /changelog will miss this deploy"
fi

log "deployed ${REMOTE_SHA:0:8}"
