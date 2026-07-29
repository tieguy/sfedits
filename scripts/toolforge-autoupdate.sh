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
# Set to "yes" once the admin console runs as a webservice.
RESTART_WEBSERVICE="${SFEDITS_RESTART_WEBSERVICE:-no}"

STATE_DIR="${SFEDITS_STATE_DIR:-$HOME/data}"
SHA_FILE="$STATE_DIR/deployed-sha"
LOCK_FILE="$STATE_DIR/autoupdate.lock"
BUILD_TIMEOUT="${SFEDITS_BUILD_TIMEOUT:-900}"   # seconds

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] $*"; }

alert() {
  local msg="$1"
  log "ALERT: $msg"
  # send-alert.js reads config.json the same way the bot does; if it is
  # unavailable we still want the non-zero exit for the job's failure email.
  node "$SCRIPT_DIR/send-alert.js" "sfedits autoupdate: $msg" || \
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

command -v toolforge >/dev/null 2>&1 || {
  # The CLI ships in bastions and (per the Toolforge changelog) in build
  # service containers. If this fires, the job image predates that rollout —
  # fall back to running this script from a bastion.
  alert "toolforge CLI not found in this environment"
  exit 1
}

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

if ! toolforge build start --ref "$BRANCH" "$REPO_URL"; then
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
  STATUS="$(toolforge build show 2>/dev/null | grep -iE '^\s*status' | head -1 || true)"
  case "$(echo "$STATUS" | tr '[:upper:]' '[:lower:]')" in
    *ok*|*success*|*complete*) log "build succeeded"; break ;;
    *fail*|*error*|*cancel*|*timeout*)
      alert "build failed for ${REMOTE_SHA:0:8} (toolforge build logs)"
      exit 1 ;;
    *) log "build in progress..." ;;
  esac
done

# --- restart -----------------------------------------------------------

# Not a rolling swap: this drops the EventStreams connection. The bot resumes
# from its own state on start, so the window is a gap in coverage, not data
# loss — but it is why this runs on a schedule rather than on every push.
log "restarting job $BOT_JOB"
if ! toolforge jobs restart "$BOT_JOB"; then
  alert "built ${REMOTE_SHA:0:8} but failed to restart $BOT_JOB"
  exit 1
fi

if [ "$RESTART_WEBSERVICE" = "yes" ]; then
  log "restarting webservice"
  toolforge webservice restart || alert "webservice restart failed after ${REMOTE_SHA:0:8}"
fi

echo "$REMOTE_SHA" > "$SHA_FILE"
log "deployed ${REMOTE_SHA:0:8}"
