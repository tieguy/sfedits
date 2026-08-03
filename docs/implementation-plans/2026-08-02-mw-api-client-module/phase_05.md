# Shared Wikimedia API Client Module — Phase 5: Live verification

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Real-Wikipedia-data proof that the migrated bot path works end-to-end,
per Louie's workflow rule ("verify against live Wikipedia data, not just unit
tests"). No new code.

**Architecture:** n/a — observation only.

**Scope:** phase 5 of 5.

**Node note (RESOLVED — historical).** An earlier draft required Node 22 here:
http-cookie-agent@6 peer-supported only undici 5/6, so Node ≥24 (bundled undici
≥7) hung every m3api request. That was fixed on this branch by upgrading to
http-cookie-agent@8 + undici@7 via npm overrides; the real-socket tests now run
ungated on all supported Node versions and live checks work on any Node ≥20.3.
`.node-version` still pins 22 as the deployment runtime.

---

## HARD BOUNDARY

Nothing in this phase pushes anywhere. **A push to `fork/integration` is a live
deploy within 15 minutes** and requires Louie's explicit go, which is OUTSIDE this
plan. This phase ends with a findings summary presented to Louie, full stop.

This phase talks to live Wikimedia hosts. All traffic goes through the module
being verified (that's the point); do not fetch Wikimedia URLs with any other
tool while verifying.

---

## Task 1: Live noop run of the bot

**Step 1: Run the bot without posting**

From the worktree root, with a valid local `config.json` (present in the main
checkout — copy it into the worktree if the worktree lacks one; it is gitignored):

```bash
cp ../../config.json . 2>/dev/null || true
timeout 300 node page-watch.js --noop --verbose 2>&1 | tee /tmp/claude-1000/-var-home-louie-Projects-Volunteering-Consulting-sfedits/b26f1d6a-7156-4e1b-bd68-edc348c489ba/scratchpad/noop-run.log
```

**Step 2: Check the evidence in the log**

- `✓ Watchlist sync: N articles from "…"` with N > 0 — the migrated
  watchlist-sync path works against live PageAssessments (or the titles_url).
- Live edits streaming in from EventStreams (edit-stream is unchanged; this
  proves the surrounding wiring).
- At least one matched edit processed end-to-end in noop mode if the watchlist
  gets traffic within the window (SF articles usually do). No posts made.
- Zero `HTTP 4xx`/`HTTP 5xx` errors attributable to the new transport; no
  m3api `DefaultUserAgentWarning` anywhere in the log (its presence means some
  session was built without our UA — a bug).

If the run window catches no matching edit, extend the timeout rather than
faking a conclusion.

---

## Task 2: Manual diff-image pipeline check

**Step 1: Render a real diff**

Pick a recent revision from live RecentChanges (from the noop log is fine) and:

```bash
node -e "
const { captureDiffImage } = require('./lib/diff-image')
captureDiffImage(process.argv[1], process.argv[2]).then(r => {
  console.log('screenshot:', r && r.screenshot)
  console.log('altText length:', r && r.altText && r.altText.length)
}).catch(e => { console.error(e); process.exit(1) })
" 'https://en.wikipedia.org/w/index.php?diff=<REVID>&oldid=<PARENT_REVID>' '<Article title>'
```

(Use a real diff URL; do NOT name a variable `URL` in `node -e` — it shadows the
global fetch uses.)

**Step 2: View the PNG** and confirm the rendered diff is coherent (highlights on
the changed text, header image present when the article has one). Send the PNG to
Louie in the summary.

---

## Task 3: Serial-discipline and compliance sweep

**Step 1: Greps**

```bash
grep -rn "Promise.all\|Promise.allSettled" lib/ scripts/ public/ | grep -v node_modules
grep -rn "USER_AGENT = '" lib/ scripts/
```

**Step 2: Review each `Promise.all` hit** — none may fan out requests at a
Wikimedia host. Known-acceptable hits are non-HTTP (e.g. internal awaits like
mw-api's session+module-load pair). Document every hit and its justification in
the findings summary.

**Step 3: Live header check** — one real request through the module, confirming
what actually goes on the wire:

```bash
node -e "
const { wmFetch } = require('./lib/mw-api')
wmFetch('https://en.wikipedia.org/api/rest_v1/page/summary/San_Francisco', { component: 'live-check' })
  .then(r => { console.log('content-encoding:', r.headers.get('content-encoding')); return r.json() })
  .then(d => console.log(d.title))
"
node -e "
const { actionSession } = require('./lib/mw-api')
actionSession('en.wikipedia.org', 'live-check')
  .then(s => s.request({ action: 'query', meta: 'siteinfo' }))
  .then(d => console.log('action api ok:', Boolean(d.query.general.sitename)))
"
```

Expected: `San Francisco` with `content-encoding: gzip` (proves gzip on the wmFetch
path), and `action api ok: true` on the m3api path (two requests total, well
within anon limits). The m3api path's Accept-Encoding comes from undici's
dispatcher, which nock cannot observe (Phase 1 documents this) — so THIS is
where it gets proven: run the m3api request with `NODE_DEBUG=undici` (or check
its response's `content-encoding`) to confirm gzip went out on the wire.

---

## Task 4: Findings summary for Louie — then STOP

Compile and present:

1. Noop-run evidence (watchlist sync line, edits processed, zero transport errors)
2. The rendered diff PNG
3. Grep results with justifications
4. Full-suite state (`SFEDITS_REQUIRE_DB=1 npm test` tail)
5. The branch's commit list (`git log --oneline integration..HEAD`)
6. Open decisions: merge to `integration` (local), and — separately, later —
   Louie's explicit go before any push to `fork/integration`

**Do not merge, do not push.** Wait for Louie.
