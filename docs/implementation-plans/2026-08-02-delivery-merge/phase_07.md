# Delivery Merge Implementation Plan — Phase 7: Docs and rollout

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Documentation matches the new reality; rollout is written as a runbook and executed only on explicit go.

**Scope:** Phase 7 of 7. Depends on Phases 1–6.

**Codebase verified:** 2026-08-02.

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge`.

---

### Task 1: Update the docs (one commit, all together — they cross-reference)

**Files:**
- Modify: `docs/deploy-toolforge.md` — §3 (config): replace the `SFEDITS_CONFIG` blob procedure with `config.base.json` + the four env vars (`toolforge envvars create SFEDITS_BLUESKY_PASSWORD …`, one per secret; note `envvars show --raw` still applies); remove PII references; add the rollout runbook (Task 2's text)
- Modify: `docs/config-topic-store.md` — document `edit_filters` on subscriptions (shape, polarity: `bots`/`minor` false = drop, `cosmetic_only` true = drop; null = no filtering), and that filters are per-subscription, outside `filters_hash`
- Modify: `README.md` — config section reflects the new shape; delivery layer mentioned; PII/Puppeteer sections gone (partly done in Phases 1–2; sweep for leftovers)
- Modify: `CLAUDE.md` (repo, gitignored — edit in the **main checkout**, not the worktree, since it's untracked): update Tech stack (no Puppeteer, no PII sidecar), Commands, Deployment (config = base file + 4 envvars), and drop stale gotchas (`.npmrc` skip-download, `#config.json#` note stays)

**Steps:** edit; `grep -rn "SFEDITS_CONFIG\|pii\|puppeteer" docs/ README.md` (excluding design-plans/implementation-plans/postmortems) comes back clean; commit tracked files.

> **Gate as-executed (2026-08-02):** "clean" here means no *stale instructions* —
> `docs/deploy-toolforge.md`'s cutover runbook necessarily names `SFEDITS_CONFIG`
> (it tells the operator to migrate off it and delete it), and two deliberate
> negative statements ("no PII sidecar", "no Chromium") remain. Do not treat the
> literal grep as a regression check.

### Task 2: Rollout runbook (write into deploy-toolforge.md; DO NOT EXECUTE without explicit operator go)

The push to `fork/integration` is a live deploy within 15 minutes (`autoupdate`), and the new code rejects `SFEDITS_CONFIG`. Order matters:

1. **Before pushing** — stage the secrets on Toolforge (values from the operator's current `SFEDITS_CONFIG`; read them with `toolforge envvars show SFEDITS_CONFIG --raw | jq`):
   `toolforge envvars create SFEDITS_BLUESKY_PASSWORD …` (×4). Do **not** delete `SFEDITS_CONFIG` yet — the running (old) code still reads it.
2. Merge `delivery-merge` → `integration` locally; run `SFEDITS_REQUIRE_DB=1 npm test` once more on the merge result.
3. **On explicit go**: push `integration` to `fork`. Migration 002 runs via `autoupdate`.
4. Verify: `/changelog` shows the new SHA; **web restarts before bot** (LUI-109); the bot log shows `✓ Watchlist sync: N articles` with N > 0; `filtered:` lines appear; one real post per platform observed (Bluesky, Mastodon, Discord).
5. **After verification**: `toolforge envvars delete SFEDITS_CONFIG`. Restart both processes once more and re-check the watchlist-sync line (proves nothing still needed the blob).
6. Rollback path: `git revert` the merge commit and push — autoupdate redeploys the old code, which reads `SFEDITS_CONFIG`; only delete the blob after a soak, if cautious.

**Steps:** write this into `docs/deploy-toolforge.md`; commit. The execution itself happens outside this plan, with the operator.

### Task 3: Final verification sweep

```bash
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
grep -rn "USER_AGENT = '" lib/        # must return nothing (CLAUDE.md invariant)
grep -rn "pii\|puppeteer\|SFEDITS_CONFIG" lib/ public/ admin/ scripts/ page-watch.js | grep -vi "no longer supported"
git log --oneline integration..delivery-merge
```

Expected: suite green; both greps clean; the log lists all phase commits. Report the final test count vs the 551 baseline with an accounting of the delta (removed PII tests vs added filter/delivery tests).

**Phase done when:** docs updated and committed, runbook written, verification sweep clean. The branch then waits for the operator's merge-and-push go.
