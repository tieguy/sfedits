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
#   1. resolve the tracked branch's head (git ls-remote, or the GitHub API
#      where the container has no git)
#   2. if the SHA matches the last deployed SHA, exit 0 silently
#   3. otherwise build, wait for the build, migrate, restart the WEBSERVICE
#      and wait for it to serve the watchlist again (the bot fetches its
#      watchlist from it at startup — LUI-109/LUI-115), then restart the bot
#   4. record the SHA only after the bot restart succeeds
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

# The bot fetches its dynamic watchlist from this tool's own webservice at
# startup (LUI-109), so restarts must go web-then-bot, and the bot restart
# waits until this URL answers (LUI-115). The default is resolved at runtime
# from the same config the bot reads (see resolve_probe_url) so it cannot
# drift from what the bot actually fetches; the literal here is the fallback.
# SFEDITS_WATCHLIST_PROBE_URL overrides; set it empty to disable the probe.
WATCHLIST_PROBE_FALLBACK="https://san-francisco-edit-stream.toolforge.org/watchlist-500.json"
WEB_WAIT_TIMEOUT="${SFEDITS_WEB_WAIT_TIMEOUT:-120}"   # seconds
case "$WEB_WAIT_TIMEOUT" in
  ''|*[!0-9]*)
    echo "SFEDITS_WEB_WAIT_TIMEOUT must be a whole number of seconds, got '$WEB_WAIT_TIMEOUT'; using 120" >&2
    WEB_WAIT_TIMEOUT=120 ;;
esac
# Every request to a Wikimedia-hosted endpoint identifies the operator.
PROBE_UA="sfedits-autoupdate (${SFEDITS_DEPLOY_REPO:-https://github.com/tieguy/sfedits}; ${SFEDITS_CONTACT:-luis@lu.is})"

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
  # send-alert.js was removed with PII screening (its recipients lived in the
  # deleted pii_alerts config); the job-failure email is the alert channel.
  log "(alert channel is the job failure email)"
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
  # CLI restart waits for the rollout itself. The API form is an async pod
  # DELETE — the old pod keeps serving while Terminating, so a URL probe
  # alone can green-light the DYING pod. webservice-restart-wait tracks pod
  # UIDs and returns only when a pod that did not exist before the delete is
  # Running and Ready (LUI-115).
  if [ "$TF_MODE" = cli ]; then toolforge webservice restart
  else tf_api webservice-restart-wait "$WEB_WAIT_TIMEOUT"; fi
}

# The URL the bot will actually fetch: read watchlist_source.titles_url from
# the same composed config the bot loads (lib/config.js). Falls back to the
# committed default when config can't be read here (e.g. pre-cutover, when
# SFEDITS_CONFIG is still set and the new loader rejects it) — measuring the
# running config beats trusting a second copy, but a probe against the
# fallback still beats no probe.
resolve_probe_url() {
  if [ -n "${SFEDITS_WATCHLIST_PROBE_URL+set}" ]; then
    echo "$SFEDITS_WATCHLIST_PROBE_URL"   # explicit override, may be empty (= disabled)
    return 0
  fi
  local from_config=""
  if [ -n "$NODE" ]; then
    from_config="$("$NODE" -e '
      try {
        const path = require("path");
        const { loadConfig } = require(path.join(process.argv[1], "..", "lib", "config"));
        const url = loadConfig({ baseDir: path.join(process.argv[1], "..") })
          .accounts?.[0]?.watchlist_source?.titles_url;
        if (url) console.log(url);
      } catch (e) { /* fall back below */ }
    ' "$SCRIPT_DIR" 2>/dev/null || true)"
  fi
  echo "${from_config:-$WATCHLIST_PROBE_FALLBACK}"
}
WATCHLIST_PROBE_URL="$(resolve_probe_url)"

# One HTTP probe of WATCHLIST_PROBE_URL. Bastions have curl; build-service
# containers do not, but they have node (found above) with global fetch.
# rc=2 means "no probe tool" — defensive only: TF_MODE selection has already
# required either the toolforge CLI (bastion, which has curl) or node.
probe_watchlist_url() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 10 -A "$PROBE_UA" -o /dev/null "$WATCHLIST_PROBE_URL"
  elif [ -n "$NODE" ]; then
    "$NODE" -e '
      fetch(process.argv[1], {
        headers: { "user-agent": process.argv[2] },
        signal: AbortSignal.timeout(10000),
      }).then((res) => process.exit(res.ok ? 0 : 1))
        .catch(() => process.exit(1));
    ' "$WATCHLIST_PROBE_URL" "$PROBE_UA"
  else
    return 2  # no probe tool; caller treats as "cannot verify"
  fi
}

# Wait until the webservice answers on the watchlist URL, bounded by
# WEB_WAIT_TIMEOUT. Sets WEB_WAIT_FAILURE for the caller's alert text.
# Returns non-zero if it never came up (or cannot be probed).
WEB_WAIT_FAILURE=""
wait_for_webservice() {
  [ -n "$WATCHLIST_PROBE_URL" ] || { log "watchlist probe disabled; not waiting"; return 0; }
  local deadline=$(( $(date +%s) + WEB_WAIT_TIMEOUT ))
  local rc
  while :; do
    rc=0; probe_watchlist_url || rc=$?
    if [ "$rc" -eq 0 ]; then
      log "webservice is answering on the watchlist URL"
      return 0
    fi
    if [ "$rc" -eq 2 ]; then
      log "no curl and no node; cannot probe the webservice"
      WEB_WAIT_FAILURE="cannot probe the webservice (no curl, no node)"
      return 1
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      WEB_WAIT_FAILURE="webservice not answering ${WEB_WAIT_TIMEOUT}s after restart"
      return 1
    fi
    sleep 5
  done
}

# Not fatal — the deploy itself is all toolforge CLI calls, and refusing to ship
# over a missing changelog would be worse than shipping without one. But it does
# mean alert() is reduced to the job's failure email, so say so once per tick
# rather than leaving it to be inferred from a later fallback line.
[ -n "$NODE" ] || log "WARNING: no node interpreter found; alerts and /changelog are degraded this run"

# Build-service containers have no git either (found the same way as the
# missing CLI: the 2026-08-02 16:30Z tick died on `git: command not found`).
# GitHub answers the same question over plain HTTPS, and node's fetch is the
# one transport the container is guaranteed to have.
resolve_remote_sha() {
  if command -v git >/dev/null 2>&1; then
    git ls-remote "$REPO_URL" "refs/heads/$BRANCH" | awk '{print $1}'
    return
  fi
  [ -n "$NODE" ] || return 1
  "$NODE" -e '
    const [repoUrl, branch] = process.argv.slice(1);
    const m = repoUrl.match(/github\.com[:\/]([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (!m) { console.error(`cannot derive a GitHub repo from ${repoUrl}`); process.exit(1); }
    fetch(`https://api.github.com/repos/${m[1]}/${m[2]}/commits/${encodeURIComponent(branch)}`, {
      headers: {
        accept: "application/vnd.github.sha",
        "user-agent": `${m[2]}-autoupdate (+${repoUrl})`,
      },
    }).then((res) => {
      if (!res.ok) throw new Error(`GitHub API returned ${res.status} for ${branch}`);
      return res.text();
    }).then((sha) => console.log(sha.trim()))
      .catch((err) => { console.error(err.message); process.exit(1); });
  ' "$REPO_URL" "$BRANCH"
}

REMOTE_SHA="$(resolve_remote_sha || true)"
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

# WEB BEFORE BOT (LUI-109 / LUI-115): the bot fetches its dynamic watchlist
# from this tool's own webservice at startup. If the web pod is mid-restart
# when the bot comes up, the first fetch fails and the bot runs with an EMPTY
# watchlist for refresh_hours (24h) — silently. So the webservice restarts
# first and the bot restart waits until the watchlist URL answers again.
# A web failure is not fatal to the deploy (the bot restart is the deploy),
# but it is alerted loudly because the quiet-bot symptom is what LUI-109
# exists to prevent.
if [ "$RESTART_WEBSERVICE" = "yes" ]; then
  log "restarting webservice (before bot: it serves the bot's watchlist)"
  if ! tf_webservice_restart; then
    alert "webservice restart failed after ${REMOTE_SHA:0:8}; bot may start with an empty watchlist"
  elif ! wait_for_webservice; then
    alert "${WEB_WAIT_FAILURE}; bot may start with an empty watchlist — check '✓ Watchlist sync' in the bot log"
  fi
fi

# Not a rolling swap: this drops the EventStreams connection. The bot resumes
# from its own state on start, so the window is a gap in coverage, not data
# loss — but it is why this runs on a schedule rather than on every push.
log "restarting job $BOT_JOB"
if ! tf_bot_restart; then
  alert "built ${REMOTE_SHA:0:8} but failed to restart $BOT_JOB"
  exit 1
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
