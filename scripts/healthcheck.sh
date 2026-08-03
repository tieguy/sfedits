#!/bin/bash
# Check that the sfedits bot is running and healthy.
# Sends DMs via Bluesky and Mastodon if anything is wrong.
#
# Checks:
# 1. Bot container is running
# 2. IRC messages received in last 30 minutes
# 3. Successful post in last 2 days
#
# Install: add to crontab on the droplet
#   */30 * * * * /root/sfedits/scripts/healthcheck.sh >> /var/log/sfedits-healthcheck.log 2>&1

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="/root/sfedits/data"
NOW=$(date +%s)
ALERT=""

# 1. Check bot container is running
BOT_RUNNING=$(docker ps --format '{{.Names}}' | grep -E 'sfedits.bot')
if [ -z "$BOT_RUNNING" ]; then
  ALERT="bot container is not running"
fi

# 2. Check IRC heartbeat (should update every few seconds)
if [ -z "$ALERT" ] && [ -f "$DATA_DIR/heartbeat-irc" ]; then
  IRC_TS=$(cat "$DATA_DIR/heartbeat-irc")
  # Convert milliseconds to seconds
  IRC_SECS=$((IRC_TS / 1000))
  IRC_AGE=$((NOW - IRC_SECS))
  if [ "$IRC_AGE" -gt 1800 ]; then
    ALERT="no IRC messages for $((IRC_AGE / 60)) minutes"
  fi
fi

# 3. Check post heartbeat (at least one post every 2 days)
if [ -z "$ALERT" ] && [ -f "$DATA_DIR/heartbeat-post" ]; then
  POST_TS=$(cat "$DATA_DIR/heartbeat-post")
  POST_SECS=$((POST_TS / 1000))
  POST_AGE=$((NOW - POST_SECS))
  TWO_DAYS=172800
  if [ "$POST_AGE" -gt "$TWO_DAYS" ]; then
    ALERT="no successful post for $((POST_AGE / 86400)) days"
  fi
fi

if [ -n "$ALERT" ]; then
  echo "[$(date)] ALERT: $ALERT"
  # send-alert.js was removed with PII screening (its recipients lived in the
  # deleted pii_alerts config); alerting is the non-zero exit + job email now.
  exit 1
else
  echo "[$(date)] OK: $BOT_RUNNING"
  exit 0
fi
