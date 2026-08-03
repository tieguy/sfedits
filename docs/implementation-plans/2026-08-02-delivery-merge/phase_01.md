# Delivery Merge Implementation Plan — Phase 1: Remove PII screening

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Delete the PII screening path entirely — code, config, tests, sidecar.

**Architecture:** `screenForPII()` and its helpers come out of `page-watch.js`; the Gemini checker module, the Python/Flask sidecar, and the PII alert plumbing are deleted. The diff-HTML fetch and `verifyDiffPage` stay (later phases use them).

**Tech Stack:** Node 20, mocha/chai/nock/proxyquire/sinon.

**Scope:** Phase 1 of 7 from `docs/design-plans/2026-08-02-delivery-merge-and-edit-filters.md`.

**Codebase verified:** 2026-08-02 (investigator, delivery-merge worktree @ 815b016).

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge` — all commands run here. `npm install` needs `PUPPETEER_SKIP_DOWNLOAD=true` until Phase 2 removes Puppeteer. Test runs: start the DB once with `npm run test:db:start`, then `SFEDITS_REQUIRE_DB=1 npm test`. Baseline: 551 passing, 1 pending.

---

### Task 1: Delete PII modules and sidecar

**Files:**
- Delete: `lib/gemini-pii-check.js`
- Delete: `pii-analyzer.py`
- Delete: `pii-service/` (entire directory: `Dockerfile`, `app.py`)
- Delete: `test/gemini-pii-check.test.js`

**Step 1: Delete the files**

```bash
git rm lib/gemini-pii-check.js pii-analyzer.py test/gemini-pii-check.test.js
git rm -r pii-service
```

**Step 2: Do NOT commit yet** — `page-watch.js` still requires `./lib/gemini-pii-check` (line 31); the suite would fail. Continue to Task 2.

### Task 2: Remove the PII path from page-watch.js

**Files:**
- Modify: `page-watch.js`

Line numbers below are pre-edit; work bottom-up so they stay valid.

**Step 1: Remove, bottom-up:**

1. Module exports (~737–738): remove `analyzeForPII` from `module.exports`.
2. In `sendStatus()` (~line 433): remove the `screenForPII(...)` call and the block that returns early / blocks the post on its result. Keep the `fetchDiffHtml` call and `verifyDiffPage` check above it untouched.
3. `screenForPII()` (~264–330): delete the whole function.
4. `sendMastodonAlert()` (~238–253): delete (only used for PII alerts).
5. `sendBlueskyAlert()` (~173–233): delete (only used for PII alerts). **Before deleting, grep for other callers** (`grep -n "sendBlueskyAlert\|sendMastodonAlert" page-watch.js admin/ scripts/`); if a non-PII caller exists, keep the function and remove only the PII call sites, noting the deviation in the commit message.
6. `logBlockedEdit()` (~155–167): delete.
7. `analyzeForPII()` (~121–150): delete.
8. Line 31: remove `const { verifyPIIWithGemini } = require('./lib/gemini-pii-check')`.

**Step 2: Verify no dangling references**

```bash
grep -n "pii\|PII" page-watch.js
```

Expected: no matches (or only incidental words — read any hit).

**Step 3: Run the suite**

```bash
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: failures only in tests that themselves reference PII (fixed in Task 3). If unrelated tests fail, stop and investigate.

### Task 3: Purge PII from remaining code, tests, config template

**Files:**
- Modify: `lib/draft-manager.js` (remove `piiDetected` / `piiConfidence` fields)
- Modify: `admin/server.js:91` — the guard is `!account.bluesky || !account.pii_alerts?.bluesky_recipient`, gating the admin console's Bluesky-DM login. Rewrite it to `!account.bluesky?.identifier` (keep the endpoint; it is already known-nonfunctional on a Discord-only account per CLAUDE.md, and deleting the admin console is out of scope). Remove any other PII alert calls in the file.
- Modify: `scripts/send-alert.js` (remove `config.pii_alerts` handling; if the script becomes PII-only dead code, `git rm` it instead and note it)
- Modify: `lib/revdel-check.js` (remove PII alert logic if present — grep first)
- Modify: `test/posting.test.js` (remove PII mocks/assertions and `pii_blocking` account fields)
- Modify: `test/fan-out.test.js` (remove `pii_blocking: { enabled: false }` from fixture accounts)
- Modify: `config.json.template` (~lines 48–81: remove the `pii_alerts` and `pii_blocking` stanzas)
- Modify: `README.md` (remove PII configuration section)
- Modify: `docs/deploy-toolforge.md` (remove `pii_blocking` from the example config)

**Step 1: Apply the edits above.** Use grep to find each site rather than trusting line numbers:

```bash
grep -rn "pii\|PII\|presidio\|gemini" --include='*.js' --include='*.json' --include='*.md' --include='*.py' \
  lib/ admin/ public/ scripts/ test/ docs/ page-watch.js config.json.template README.md | grep -v node_modules | grep -v design-plans | grep -v implementation-plans
```

Work through every hit. Historical docs (`docs/postmortem*`, old implementation plans under `docs/implementation-plans/2026-07-23-*`) stay unchanged — they describe the past.

**Step 2: Verify grep-clean**

Re-run the grep from Step 1. Expected: no hits outside `docs/design-plans/`, `docs/implementation-plans/`, and postmortems.

**Step 3: Run the full suite**

```bash
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: passing, 1 pending; count will be below 551 by exactly the number of removed PII tests.

**Step 4: Commit**

```bash
git add -A
git commit -m "feat!: remove PII screening entirely

Deletes screenForPII, the Gemini checker, the Presidio sidecar, PII
alerts, and the pii_blocking/pii_alerts config stanzas. Diff HTML fetch
and page verification remain.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Phase done when:** the Step-1 grep is clean, suite is green with `SFEDITS_REQUIRE_DB=1`, and the commit exists.
