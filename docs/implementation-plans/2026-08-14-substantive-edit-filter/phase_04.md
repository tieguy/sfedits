# Substantive-Edit Filter Implementation Plan — Phase 4: Live Log-Only Deployment

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Run the classifier against the real edit stream in production, logging verdicts and dropping nothing, then measure the would-drop rate over several days.

**Architecture:** Config-only change: `"substantive_only": "log"` on each delivery in `config.base.json`, shipped by merging this branch to `integration` and pushing to `fork/integration` (which deploys via autoupdate within 15 minutes).

**Scope:** 5 phases from `docs/design-plans/2026-08-14-substantive-edit-filter.md` (this file: phase 4).

**Codebase verified:** 2026-08-14. Live deliveries in `config.base.json` (lines 28-32): discord, mastodon, bluesky, each with `edit_filters: { bots: false, minor: false }`. Deploy mechanics per `docs/deploy-toolforge.md` and CLAUDE.md: push to `fork/integration` IS a deploy; autoupdate ticks every 15 min; verify deploys via `/changelog.json` (newest entry last); restart order gotcha (web before bot) applies only to manual restarts — autoupdate handles it.

**⛔ OUTWARD-FACING GATE:** Every task below that pushes requires Louie's explicit "go" first. Prepare, present, wait. This is a workflow rule, not a suggestion.

---

### Task 1: Config change (prepare only)

**Files:**
- Modify: `config.base.json` (the `deliveries` array)

**Step 1: Edit each delivery entry** from

```json
{ "type": "discord", "edit_filters": { "bots": false, "minor": false } }
```

to

```json
{ "type": "discord", "edit_filters": { "bots": false, "minor": false, "substantive_only": "log" } }
```

(same addition for the mastodon and bluesky entries).

**Step 2: Verify config loads and normalizes**

```bash
node -e "
const { loadConfig } = require('./lib/config')
const { normalizeEditFilters } = require('./lib/edit-filters')
const cfg = loadConfig()
for (const d of cfg.accounts[0].deliveries) {
  console.log(d.type, normalizeEditFilters(d.edit_filters))
}"
```
Expected: three lines, each showing `substantive_only: 'log'`.

**Step 3: Run the full suite, then commit (commit is local — still not a deploy)**

```bash
SFEDITS_REQUIRE_DB=1 npm test
git add config.base.json
git commit -m "$(cat <<'EOF'
feat: run the substantive-edit classifier in log-only mode on all deliveries

Verdicts are logged for every candidate edit; nothing is dropped yet.
Enforcement is a later config flip once live verdicts are reviewed.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 2: Merge and deploy (REQUIRES EXPLICIT GO)

**Step 1: Present to Louie** — a short summary of what will ship (Phases 1–3 code + the log-only config), the expected observable change (only new log lines; the posted feed is unchanged), and the rollback (revert the config commit, push).

**Step 2: WAIT for explicit go. Do not proceed on silence.**

**Step 3: After go — merge to integration and push**

```bash
# from the main checkout, not the worktree
cd /var/home/louie/Projects/Volunteering-Consulting/sfedits
git status --short   # confirm only untracked noise; another session may be mid-work — if in doubt, STOP and ask
git checkout integration
git merge --no-ff substantive-edit-filter -m "$(cat <<'EOF'
merge: substantive-edit filter (log-only)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
SFEDITS_REQUIRE_DB=1 npm test
git push fork integration
```

If the sandboxed push fails on keyring/askpass, retry with the sandbox disabled (known machine behavior — a sandbox problem, not an auth problem).

**Step 4: Verify the deploy** per the runbook: within ~15 minutes,

```bash
curl -s https://san-francisco-edit-stream.toolforge.org/changelog.json | tail -c 400
```
Expected: newest entry (last) records the merge SHA. Then check the bot log for the watchlist-sync line and the first `substantive-verdict:` lines (commands in `docs/deploy-toolforge.md`; `toolforge jobs logs bot` from the bastion, or the tool's log files).

---

### Task 3: Measure over 2–4 days

**Step 1: Pull verdict lines from the bot log** (from the bastion; exact log access commands per `docs/deploy-toolforge.md`):

count per day, would-drop rate, fallback rate, and reason distribution. A quick pass over a copied log file:

```bash
grep -c 'substantive-verdict:' bot.log
grep 'substantive-verdict:' bot.log | grep -c 'substantive=false'
grep 'substantive-verdict:' bot.log | grep -c 'fallback='
grep 'substantive-verdict:' bot.log | grep -o 'ignored=\[[^]]*\]' | sort | uniq -c | sort -rn | head
```

**Step 2: Compare against predictions** (design §Architecture, measured 2026-08-14): ~40 verdicts/day, ~35% substantive=false, near-zero fallback. Date the measured numbers.

**Step 3: Spot-check 20 substantive=false verdicts** by opening their diffs: each must be an edit a feed reader genuinely wouldn't miss. Any false drop (a substantive edit classified not-substantive) is a Phase 1 bug: fix, add a regression fixture, re-run validation, and restart this measurement window.

Include in the spot-check at least one **collapsed edit** (a verdict whose page also has a `Wikipedia article edited N times` post or a collapse log entry nearby): confirm the verdict was computed over the burst's combined oldest→newest diff, i.e. the net change — this pins the design's collapser-semantics claim against reality.

**Step 3b: Watch for event-loop stalls.** Each classification runs two synchronous wtf_wikipedia parses on the bot's event loop. At ~40 edits/day this should be invisible, but check the log timestamps around verdicts on the largest articles (San Francisco is ~277KB): if EventStreams reconnects or heartbeat gaps correlate with verdict lines, note it — the fix (worker thread or size-capped parse) becomes a follow-up before enforcement, not after.

**Step 4: Append the findings** (dated, with denominators) to the Phase 2 analysis doc; commit that doc update on the `substantive-edit-filter` branch or directly on `integration` per Louie's preference at the time.

---

**Phase 4 done when:** the log-only deploy is verified via `/changelog.json`; 2–4 days of verdicts are measured and written up; the spot-check found no false drops (or bugs found were fixed and the window restarted). **The measured would-drop rate and samples are the input Louie reviews before Phase 5's enforcement flip.**
