# Substantive-Edit Filter Implementation Plan — Phase 5: Enable and Document

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Flip the filter from log-only to enforcing on the live deliveries, verify the feed, and update the docs to describe the new present.

**Architecture:** Config-only flip (`"log"` → `true`) plus documentation. Rollback at any time is deleting the key (or setting `"log"`) and pushing.

**Scope:** 5 phases from `docs/design-plans/2026-08-14-substantive-edit-filter.md` (this file: phase 5, final).

**Codebase verified:** 2026-08-14 (see phase_04.md header; nothing new is touched here beyond config and docs).

**Prerequisite:** Phase 4's measured results reviewed by Louie, and Louie's explicit decision to enforce.

**⛔ OUTWARD-FACING GATE:** the push in Task 2 requires explicit go.

---

### Task 1: Flip the config (prepare only)

**Files:**
- Modify: `config.base.json` — each delivery's `"substantive_only": "log"` → `"substantive_only": true`

**Step 1: Edit, verify, run suite, commit** (mirror phase_04 Task 1's verification):

```bash
node -e "
const { loadConfig } = require('./lib/config')
const { normalizeEditFilters } = require('./lib/edit-filters')
for (const d of loadConfig().accounts[0].deliveries) console.log(d.type, normalizeEditFilters(d.edit_filters).substantive_only)"
SFEDITS_REQUIRE_DB=1 npm test
git add config.base.json
git commit -m "$(cat <<'EOF'
feat: enforce the substantive-edit filter on all deliveries

Log-only review found no false drops (see the validation analysis doc);
non-substantive edits (template churn, category/link gnoming) no longer post.
Rollback: set the flag back to "log" or delete it.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```
Expected before commit: three lines each printing `true`; suite green.

---

### Task 2: Deploy (REQUIRES EXPLICIT GO) and verify live

**Step 1: Present** the flip to Louie with the Phase 4 measured numbers. **WAIT for go.**

**Step 2: Push** (same mechanics and cautions as phase_04 Task 2 — check `git status --short` in the main checkout first, sandbox-disabled retry if keyring blocks the push).

**Step 3: Verify live behavior over the next day:**
- `/changelog.json` records the deploy.
- Bot log shows `filtered: … (substantive_only: …)` lines appearing.
- Compare one day of Mastodon posts against that day's `substantive-verdict:` log lines: every posted edit's verdict was substantive (or fallback), and post volume ≈ the measured substantive rate from Phase 4.
- Confirm zero `fallback=` verdicts resulted in drops (by construction they cannot; verify anyway — `grep 'filtered:.*substantive_only' bot.log` entries should never correspond to a fallback verdict line for the same page+time).

---

### Task 3: Documentation updates

**Files:**
- Modify: `docs/deploy-toolforge.md` — in the config reference section, document the `substantive_only` key: three states, per-delivery placement, `substantive_channels` override, rollback-by-config
- Modify: `CLAUDE.md` (repo root, gitignored local context) — add to the module tables/gotchas: `lib/edit-significance.js` (pure classifier; channel policy), `lib/revision-pair.js`, the three-state flag, the conservative-pass invariant ("the significance filter may only remove noise — any failure passes"), and the live filter state
- Modify: the Phase 2 analysis doc — final dated section: enforcement date, first-day verified numbers

**Step 1: Write the doc changes.** Present tense only — describe the filter as it now is; no narration of the rollout history in `deploy-toolforge.md` (history lives in the analysis doc and git). Grep the diff for the tells (`used to`, `previously`, `no longer`) before committing.

**Step 2: Commit** (`docs:` prefix, standard trailers). Note `CLAUDE.md` is gitignored in this repo — edit it, don't stage it.

---

**Phase 5 done when:** enforcement is live and verified (Task 2 checks), docs updated and committed, and the feed's daily volume matches the Phase 4 prediction. Follow-ups now unblocked (not part of this plan): rate-targeted sizing design; `wtf-plugin-diff` extraction; LUI-166 eswiki feed.
