# Substantive-Edit Filter Implementation Plan — Phase 2: Offline Validation

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Measure `classifyEdit()` against mwedittypes labels across three cohorts (SFBA top-500, recent-window enwiki, recent-window eswiki). This phase is the design's go/no-go gate, and the gate is **directional**: of the edits mwedittypes labels prose-touching, ≥95% per cohort must classify substantive. The reverse bucket (we say substantive, no prose key — infobox/ref/media/heading changes) is characterized and hand-reviewed, never gated.

**Architecture:** Reproducible tooling in `scripts/analysis/edit-significance/` harvests edits, fetches wikitext pairs, labels them with the Python mwedittypes library, runs our classifier over the same pairs, and reports confusion matrices plus disagreement samples. Cohort data lives in gitignored `data/edit-significance-validation/`.

**Tech Stack:** Node 22 + `lib/mw-api.js` (all Wikimedia fetches — serial, compliant UA), Python venv + `mwedittypes` (pure-Python `mwparserfromhell` build), `lib/edit-significance.js` from Phase 1.

**Scope:** 5 phases from `docs/design-plans/2026-08-14-substantive-edit-filter.md` (this file: phase 2).

**Codebase verified:** 2026-08-14. `scripts/analysis/` does not exist yet. Prior-run artifacts exist OUTSIDE the worktree in the main checkout at `/var/home/louie/Projects/Volunteering-Consulting/sfedits/data/edit-significance-validation/` (gitignored): `selected-edits.json` + `edit-types-labels.jsonl` (the 1,219-edit SFBA cohort, labeled 2026-08-14), `revisions-30d.json`, `user-groups.json`, `live-watchlist.json`, and the original one-off scripts (`harvest-revisions.js`, `fetch-user-groups.js`, `fetch-pairs.js`, `classify.py`, `analyze-types.js`) these tasks adapt.

**Wikimedia API rules (non-negotiable, from CLAUDE.md):** every fetch goes through `lib/mw-api.js` with a `component` string; requests strictly serial; no `Promise.all` at Wikimedia hosts.

---

### Task 1: Directory scaffold, gitignore, and cohort layout

**Files:**
- Modify: `.gitignore` (there is NO wholesale `data/` rule — only specific paths like `data/reassess/` are listed; verified 2026-08-14)
- Create: `scripts/analysis/edit-significance/README.md`

**Step 0: Gitignore the cohort data** — append to `.gitignore`, next to the existing `data/reassess/` entry:

```
data/edit-significance-validation/
```

Verify: `git check-ignore -v data/edit-significance-validation/x` prints the new rule. Without this, Task 5's Python venv and hundreds of MB of cohort wikitext become committable.

**Step 1: Create the README** (it defines the cohort layout every later script uses)

```markdown
# edit-significance validation tooling

Measures lib/edit-significance.js against mwedittypes labels.
Design: docs/design-plans/2026-08-14-substantive-edit-filter.md (Phase 2).

Cohort layout (all under data/edit-significance-validation/, gitignored):

    <cohort>/edits.json        [{title, revid, parentid, ts, user, tags, comment}]
    <cohort>/pairs-cache/      one <revid>.txt wikitext file per revision
    <cohort>/labels.jsonl      {"revid", "title", "types": {mwedittypes diff}} per line
    <cohort>/verdicts.jsonl    {"revid", "substantive", "reasons", "ignored"} per line

Cohorts: sfba (imported from the 2026-08-14 analysis run), enwiki-random,
eswiki-random. The "-random" cohorts are sliced samples across a ~29-day
recentchanges window, one slice per 23-hour step so time-of-day precesses
across the clock (not a single most-recent slice, and not uniform random —
say "recent-window sample" in writeups).

Pipeline per cohort (all run from the repo root):

    node scripts/analysis/edit-significance/harvest-recentchanges.js <host> <cohort> <count> [--days 30]   # skip for sfba
    node scripts/analysis/edit-significance/fetch-pairs.js <cohort> [--host <host>]
    ./data/edit-significance-validation/venv/bin/python scripts/analysis/edit-significance/label-mwedittypes.py <cohort> <lang>
    node scripts/analysis/edit-significance/validate.js <cohort> [lang]

Gate (design): directional — of edits mwedittypes labels prose-touching,
>=95% must classify substantive. The reverse bucket (we-say-substantive-only)
is expected: infobox/ref/media/heading changes live under non-prose
mwedittypes keys. It is characterized and hand-reviewed, never gated.

Python setup (mwparserfromhell needs Python.h for its C tokenizer; use the
pure-Python fallback):

    python3 -m venv data/edit-significance-validation/venv
    WITHOUT_EXTENSION=1 data/edit-significance-validation/venv/bin/pip install mwparserfromhell
    data/edit-significance-validation/venv/bin/pip install mwedittypes
```

**Step 2: Verify and commit**

```bash
ls scripts/analysis/edit-significance/README.md
git check-ignore -q data/edit-significance-validation/x && echo ignored-ok
git add .gitignore scripts/analysis/edit-significance/README.md
git commit -m "$(cat <<'EOF'
chore: scaffold edit-significance validation tooling, ignore its data dir

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 2: Import the SFBA cohort from the 2026-08-14 run

**Files:**
- Create (data only, gitignored — no commit): `data/edit-significance-validation/sfba/`

**Step 1: Import**

```bash
SRC=/var/home/louie/Projects/Volunteering-Consulting/sfedits/data/edit-significance-validation
DST=data/edit-significance-validation/sfba
mkdir -p "$DST"
cp "$SRC/selected-edits.json" "$DST/edits.json"
cp "$SRC/edit-types-labels.jsonl" "$DST/labels.jsonl"
```

**Step 2: Verify**

```bash
node -e "const e=require('./data/edit-significance-validation/sfba/edits.json');console.log('edits:',e.length)"
wc -l data/edit-significance-validation/sfba/labels.jsonl
node -e "const fs=require('fs');const ids=new Set();for(const l of fs.readFileSync('data/edit-significance-validation/sfba/labels.jsonl','utf-8').trim().split('\n'))ids.add(JSON.parse(l).revid);console.log('unique:',ids.size)"
```
Expected: `edits: 1219`; **1281 label lines** (the source run resumed once, leaving 62 duplicate lines) but `unique: 1219`. Duplicates are harmless — `validate.js` keys by revid. No commit (the directory is gitignored as of Task 1).

---

### Task 3: harvest-recentchanges.js — random cohort sampler

**Files:**
- Create: `scripts/analysis/edit-significance/harvest-recentchanges.js`

**Step 1: Write the script**

```javascript
// Sample recent mainspace human edits from a wiki via list=recentchanges,
// one slice per 23-hour step across a window. The 23-hour (not 24) stride
// is deliberate: successive slices precess one hour later in the day, so
// over 24+ slices the cohort covers every time of day AND every day of week
// (measurement hygiene: gnoming rates vary diurnally with bot/tool
// schedules and editor geography). Checkpoints edits.json per slice; resumable.
// Usage: node scripts/analysis/edit-significance/harvest-recentchanges.js <host> <cohort> <count> [--days 30]
//   e.g. node .../harvest-recentchanges.js en.wikipedia.org enwiki-random 1500
// recentchanges rows carry both revid and old_revid, so no per-title history
// pass is needed. Mirrors the live metadata filter: bots and minor excluded.
// (recentchanges retains ~30 days; --days above that returns empty slices.)
const fs = require('fs')
const path = require('path')
const { actionSession } = require('../../../lib/mw-api')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')

async function main() {
  const args = process.argv.slice(2)
  const [host, cohort, countArg] = args
  const target = Number(countArg)
  const daysIdx = args.indexOf('--days')
  const days = daysIdx > -1 ? Number(args[daysIdx + 1]) : 30
  if (!host || !cohort || !Number.isFinite(target) || !Number.isFinite(days) || days < 1) {
    console.error('usage: harvest-recentchanges.js <host> <cohort> <count> [--days 30]')
    process.exit(1)
  }
  const dir = path.join(DATA_ROOT, cohort)
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, 'edits.json')

  // Resume: existing edits count toward the target; already-covered days
  // (tracked in edits-meta.json) are skipped.
  const metaPath = path.join(dir, 'edits-meta.json')
  const edits = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath)) : []
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : { doneDays: [] }
  const seen = new Set(edits.map(e => e.revid))
  const perDay = Math.ceil(target / days)

  const session = await actionSession(host, 'edit-significance-validation')
  const now = Date.now()
  for (let day = 0; day < days && edits.length < target; day++) {
    if (meta.doneDays.includes(day)) continue
    // 23-hour stride: each slice starts an hour later in the day than the
    // last, so time-of-day precesses across the full clock over the window.
    const rcstart = new Date(now - day * 23 * 3600 * 1000).toISOString()
    let got = 0
    let rccontinue
    while (got < perDay) {
      const params = {
        action: 'query', list: 'recentchanges',
        rcstart,
        rcnamespace: 0, rctype: 'edit', rcshow: '!bot|!minor',
        rcprop: 'title|ids|timestamp|user|tags|comment',
        rclimit: 'max', formatversion: 2
      }
      if (rccontinue) params.rccontinue = rccontinue
      const resp = await session.request(params)
      for (const rc of resp.query.recentchanges) {
        if (!rc.old_revid) continue // page creations have no pair
        if (seen.has(rc.revid)) continue
        seen.add(rc.revid)
        edits.push({
          title: rc.title, revid: rc.revid, parentid: rc.old_revid,
          ts: rc.timestamp, user: rc.user, tags: rc.tags || [], comment: rc.comment || ''
        })
        got++
        if (got >= perDay || edits.length >= target) break
      }
      rccontinue = resp.continue?.rccontinue
      if (!rccontinue) break
    }
    meta.doneDays.push(day)
    fs.writeFileSync(outPath, JSON.stringify(edits))
    fs.writeFileSync(metaPath, JSON.stringify(meta))
    console.log(`day-offset ${day}: +${got}, total ${edits.length}/${target}`)
  }
  console.log(`done: ${edits.length} edits -> ${cohort}/edits.json (${meta.doneDays.length} day slices)`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

**Step 2: Smoke-test with a tiny sample**

```bash
node scripts/analysis/edit-significance/harvest-recentchanges.js en.wikipedia.org smoke 25 --days 1
node -e "const e=require('./data/edit-significance-validation/smoke/edits.json');console.log(e.length, e[0])"
rm -r data/edit-significance-validation/smoke
```
Expected: 25 edits, first row has `title`, `revid`, `parentid`, `tags`.

**Step 3: Commit**

```bash
git add scripts/analysis/edit-significance/harvest-recentchanges.js
git commit -m "$(cat <<'EOF'
feat: recentchanges cohort sampler for classifier validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 4: fetch-pairs.js — wikitext pair cache

**Files:**
- Create: `scripts/analysis/edit-significance/fetch-pairs.js`

Adapted from the one-off at `/var/home/louie/Projects/Volunteering-Consulting/sfedits/data/edit-significance-validation/fetch-pairs.js`; this version is cohort-aware, takes the host from a `--host` flag (default `en.wikipedia.org`), and reads `<cohort>/edits.json` directly.

**Step 1: Write the script**

```javascript
// Fetch wikitext for both sides of each edit in a cohort, cached one file
// per revid. Batched 10 revids/request, strictly serial, resumable.
// Usage: node scripts/analysis/edit-significance/fetch-pairs.js <cohort> [--host en.wikipedia.org]
const fs = require('fs')
const path = require('path')
const { actionSession } = require('../../../lib/mw-api')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')

async function main() {
  const args = process.argv.slice(2)
  const cohort = args[0]
  const hostIdx = args.indexOf('--host')
  const host = hostIdx > -1 ? args[hostIdx + 1] : 'en.wikipedia.org'
  if (!cohort) { console.error('usage: fetch-pairs.js <cohort> [--host <host>]'); process.exit(1) }

  const dir = path.join(DATA_ROOT, cohort)
  const cache = path.join(dir, 'pairs-cache')
  fs.mkdirSync(cache, { recursive: true })
  const edits = JSON.parse(fs.readFileSync(path.join(dir, 'edits.json')))

  const needed = new Set()
  for (const e of edits) { needed.add(e.revid); needed.add(e.parentid) }
  const toFetch = [...needed].filter(id => !fs.existsSync(path.join(cache, `${id}.txt`)))
  console.log(`${edits.length} edits, ${needed.size} revids, ${toFetch.length} to fetch`)

  const session = await actionSession(host, 'edit-significance-validation')
  let done = 0
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10)
    const resp = await session.request({
      action: 'query', prop: 'revisions', revids: batch.join('|'),
      rvslots: 'main', rvprop: 'ids|content', formatversion: 2
    })
    for (const page of resp.query?.pages || []) {
      for (const r of page.revisions || []) {
        fs.writeFileSync(path.join(cache, `${r.revid}.txt`), r.slots?.main?.content ?? '')
      }
    }
    // Revisions the API refused (revdeleted/suppressed): empty marker, not a refetch loop.
    for (const id of batch) {
      const f = path.join(cache, `${id}.txt`)
      if (!fs.existsSync(f)) fs.writeFileSync(f, '')
    }
    done += batch.length
    if (done % 200 < 10) console.log(`${done}/${toFetch.length}`)
  }
  console.log(`done: ${toFetch.length} fetched`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
```

**Step 2: Smoke-test** (re-harvest a tiny cohort, fetch it, inspect)

```bash
node scripts/analysis/edit-significance/harvest-recentchanges.js en.wikipedia.org smoke 10 --days 1
node scripts/analysis/edit-significance/fetch-pairs.js smoke
ls data/edit-significance-validation/smoke/pairs-cache | head -3
rm -r data/edit-significance-validation/smoke
```
Expected: ~20 `.txt` files, non-empty for ordinary revisions.

**Step 3: Commit**

```bash
git add scripts/analysis/edit-significance/fetch-pairs.js
git commit -m "$(cat <<'EOF'
feat: cohort wikitext-pair fetcher for classifier validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 5: label-mwedittypes.py — ground-truth labeler

**Files:**
- Create: `scripts/analysis/edit-significance/label-mwedittypes.py`

Adapted from the one-off `classify.py` in the same data directory: cohort-aware, takes `lang` as an argument, resumable.

**Step 1: Set up the Python environment** (once)

```bash
python3 -m venv data/edit-significance-validation/venv
WITHOUT_EXTENSION=1 data/edit-significance-validation/venv/bin/pip install -q mwparserfromhell
data/edit-significance-validation/venv/bin/pip install -q mwedittypes
data/edit-significance-validation/venv/bin/python -c "from mwedittypes import SimpleEditTypes; print(SimpleEditTypes('wikitext','a','a b').get_diff())"
```
Expected: a dict like `{'Section': …, 'Word': {'insert': 1}, …}` — proves the pure-Python build works.

**Step 2: Write the script**

```python
#!/usr/bin/env python3
"""Label a cohort's edits with mwedittypes SimpleEditTypes.
Usage: label-mwedittypes.py <cohort> <lang>   (lang: en | es)
Reads <cohort>/edits.json + pairs-cache/, appends to <cohort>/labels.jsonl (resumable).
"""
import json
import os
import sys

from mwedittypes import SimpleEditTypes

DATA_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                         "../../../data/edit-significance-validation")

def main():
    if len(sys.argv) != 3:
        print("usage: label-mwedittypes.py <cohort> <lang>", file=sys.stderr)
        sys.exit(1)
    cohort, lang = sys.argv[1], sys.argv[2]
    cdir = os.path.join(DATA_ROOT, cohort)
    cache = os.path.join(cdir, "pairs-cache")
    out_path = os.path.join(cdir, "labels.jsonl")

    with open(os.path.join(cdir, "edits.json")) as f:
        edits = json.load(f)

    done = set()
    if os.path.exists(out_path):
        with open(out_path) as f:
            for line in f:
                try:
                    done.add(json.loads(line)["revid"])
                except Exception:
                    pass

    n = 0
    with open(out_path, "a") as out:
        for e in edits:
            if e["revid"] in done:
                continue
            try:
                with open(os.path.join(cache, f"{e['parentid']}.txt")) as f:
                    prev = f.read()
                with open(os.path.join(cache, f"{e['revid']}.txt")) as f:
                    curr = f.read()
            except FileNotFoundError:
                continue
            if not prev or not curr:
                rec = {"revid": e["revid"], "title": e["title"], "error": "missing-content"}
            else:
                try:
                    diff = SimpleEditTypes("wikitext", prev, curr, lang=lang).get_diff()
                    rec = {"revid": e["revid"], "title": e["title"], "types": diff}
                except Exception as ex:
                    rec = {"revid": e["revid"], "title": e["title"], "error": str(ex)[:200]}
            out.write(json.dumps(rec) + "\n")
            n += 1
            if n % 100 == 0:
                out.flush()
                print(f"{n} labeled", file=sys.stderr)
    print(f"done: {n} newly labeled")

if __name__ == "__main__":
    main()
```

Note: labeling is local CPU work — if a cohort is slow, it is fine to run several `label-mwedittypes.py` processes over *different cohorts* concurrently. (Wikimedia fetches stay serial; this rule is about local parsing only.)

**Step 3: Commit**

```bash
git add scripts/analysis/edit-significance/label-mwedittypes.py
git commit -m "$(cat <<'EOF'
feat: mwedittypes ground-truth labeler for classifier validation

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 6: validate.js — verdicts, confusion matrix, disagreement samples

**Files:**
- Create: `scripts/analysis/edit-significance/validate.js`

**Step 1: Write the script**

```javascript
// Run classifyEdit over a cohort's cached pairs and compare with mwedittypes
// labels. The GATE is directional (design §Phase 2): of edits mwedittypes
// labels prose-touching (Word/Sentence/Paragraph/Character), >=95% must
// classify substantive. The reverse bucket (we say substantive, no prose
// key) is EXPECTED — infobox values, references, media, tables and headings live
// under non-prose mwedittypes keys — so it is characterized, not gated.
// Usage: node scripts/analysis/edit-significance/validate.js <cohort> [lang]
const fs = require('fs')
const path = require('path')
const { classifyEdit } = require('../../../lib/edit-significance')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')
const PROSE_KEYS = new Set(['Word', 'Sentence', 'Paragraph', 'Character'])
// mwedittypes keys that map directly onto our substantive non-prose
// channels — used to characterize (not gate) the we-say-substantive-only
// bucket. Template is deliberately NOT here: template churn is an ignored
// channel, so a substantive verdict on a Template-keyed edit is only
// expected when wtf rendered the template into prose/infobox values —
// those are counted separately so a real over-trigger class can't hide.
const MAPPED_KEYS = new Set(['Reference', 'Media', 'Heading'])

function main() {
  const cohort = process.argv[2]
  const lang = process.argv[3] || 'en'
  if (!cohort) { console.error('usage: validate.js <cohort> [lang]'); process.exit(1) }
  const dir = path.join(DATA_ROOT, cohort)
  const cache = path.join(dir, 'pairs-cache')
  const edits = JSON.parse(fs.readFileSync(path.join(dir, 'edits.json')))
  const labels = new Map()
  for (const line of fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf-8').trim().split('\n')) {
    const rec = JSON.parse(line)
    labels.set(rec.revid, rec)
  }

  const out = fs.createWriteStream(path.join(dir, 'verdicts.jsonl'))
  let n = 0
  let skipped = 0
  let proseLabeled = 0
  let proseCaught = 0
  let bothNot = 0
  const missedProse = []   // mwedittypes says prose, we say not substantive — the gated failure mode
  const extraSubstantive = [] // we say substantive, mwedittypes has no prose key — characterized only
  for (const e of edits) {
    const label = labels.get(e.revid)
    if (!label || label.error || !label.types) { skipped++; continue }
    let prev, curr
    try {
      prev = fs.readFileSync(path.join(cache, `${e.parentid}.txt`), 'utf-8')
      curr = fs.readFileSync(path.join(cache, `${e.revid}.txt`), 'utf-8')
    } catch { skipped++; continue }
    if (!prev || !curr) { skipped++; continue }
    const v = classifyEdit(prev, curr, { lang })
    out.write(JSON.stringify({ revid: e.revid, ...v }) + '\n')
    n++
    const prose = Object.keys(label.types).some(k => PROSE_KEYS.has(k))
    if (prose) {
      proseLabeled++
      if (v.substantive) proseCaught++
      else missedProse.push({ revid: e.revid, title: e.title, ignored: v.ignored, types: Object.keys(label.types) })
    } else if (v.substantive) {
      const keys = Object.keys(label.types)
      const mapped = keys.some(k => MAPPED_KEYS.has(k))
      const templateOnly = !mapped && keys.includes('Template')
      extraSubstantive.push({ revid: e.revid, title: e.title, reasons: v.reasons, mapped, templateOnly, types: keys })
    } else {
      bothNot++
    }
  }
  out.end()

  console.log(`cohort=${cohort} lang=${lang} compared=${n} skipped=${skipped}`)
  if (proseLabeled === 0) {
    console.log('GATE: FAIL — zero prose-labeled edits; cohort or labels are broken')
    process.exit(1)
  }
  const caughtPct = proseCaught / proseLabeled * 100
  console.log(`prose-labeled=${proseLabeled}  caught=${proseCaught} (${caughtPct.toFixed(1)}%)  missed=${missedProse.length}`)
  console.log(`both-not-substantive=${bothNot}`)
  const mappedCount = extraSubstantive.filter(d => d.mapped).length
  const templateOnlyCount = extraSubstantive.filter(d => d.templateOnly).length
  const unexplained = extraSubstantive.length - mappedCount - templateOnlyCount
  console.log(`we-say-substantive-only=${extraSubstantive.length} ` +
    `(${mappedCount} carry mwedittypes Reference/Media/Heading keys — expected by design; ` +
    `${templateOnlyCount} carry only Template keys — expected ONLY when wtf renders the template, review a sample; ` +
    `${unexplained} carry neither — review every one)`)
  console.log('\nsample missed-prose (GATED — every one is a potential classifier bug; up to 15):')
  for (const d of missedProse.slice(0, 15)) console.log(' ', JSON.stringify(d))
  console.log('\nsample we-say-substantive-only, Template-only labels (up to 10):')
  for (const d of extraSubstantive.filter(x => x.templateOnly).slice(0, 10)) console.log(' ', JSON.stringify(d))
  console.log('\nsample we-say-substantive-only with neither prose nor mapped nor Template keys (up to 15):')
  for (const d of extraSubstantive.filter(x => !x.mapped && !x.templateOnly).slice(0, 15)) console.log(' ', JSON.stringify(d))
  const pass = caughtPct >= 95
  console.log(`\nGATE (design, directional): caught/prose-labeled = ${proseCaught}/${proseLabeled} ` +
    `= ${caughtPct.toFixed(1)}% >= 95% -> ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
main()
```

**Step 2: Run against the imported SFBA cohort** (pairs must be fetched first — the prior run's 232MB cache was not preserved):

```bash
node scripts/analysis/edit-significance/fetch-pairs.js sfba
node scripts/analysis/edit-significance/validate.js sfba
```
Expected: `compared=` near 1219, the directional gate line, and the characterization counts. **Read the disagreement samples, don't just read the percentage** — every `missed-prose` entry is a potential classifier bug and each sampled one must be explainable; the unmapped slice of `we-say-substantive-only` also needs eyeballs.

**Step 3: Commit**

```bash
git add scripts/analysis/edit-significance/validate.js
git commit -m "$(cat <<'EOF'
feat: classifier-vs-mwedittypes validation harness

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 7: Run the three cohorts and write the analysis doc

**Files:**
- Create: `docs/2026-XX-XX-edit-significance-validation.md` (substitute the actual run date)

**Step 1: Harvest, fetch, label, validate the two random cohorts**

```bash
node scripts/analysis/edit-significance/harvest-recentchanges.js en.wikipedia.org enwiki-random 1500
node scripts/analysis/edit-significance/fetch-pairs.js enwiki-random
data/edit-significance-validation/venv/bin/python scripts/analysis/edit-significance/label-mwedittypes.py enwiki-random en
node scripts/analysis/edit-significance/validate.js enwiki-random

node scripts/analysis/edit-significance/harvest-recentchanges.js es.wikipedia.org eswiki-random 1000
node scripts/analysis/edit-significance/fetch-pairs.js eswiki-random --host es.wikipedia.org
data/edit-significance-validation/venv/bin/python scripts/analysis/edit-significance/label-mwedittypes.py eswiki-random es
node scripts/analysis/edit-significance/validate.js eswiki-random es
```

Also label + validate the SFBA cohort if not done in Task 6. Inspect a ~25-edit slice of each cohort's labels before the full labeling run (measurement hygiene: check output distributions, not just absence of errors).

**Step 2: Hand-review ~30 disagreements per cohort.** For each sampled disagreement decide: judgment difference (e.g. infobox values — defensible) or classifier bug (fix in `lib/edit-significance.js`, add a regression fixture pair in `test/fixtures/wikitext-pairs/`, re-run validate).

**Step 3: Write the analysis doc** with: dated per-cohort tables (compared, skipped, agreement %, both-substantive, both-not, each disagreement direction), the reviewed disagreement classes with counts, the es-specific template-rendering findings, and the GATE verdicts. Follow the style of `docs/importance-ranking-methodology.md` §8.3 (dated measured numbers with explicit denominators).

**Step 4: Commit**

```bash
git add docs/2026-XX-XX-edit-significance-validation.md
git commit -m "$(cat <<'EOF'
docs: substantive-edit classifier validation results (three cohorts)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

**Phase 2 done when:** all three cohorts report their directional GATE line in the analysis doc; every cohort catches ≥95% of prose-labeled edits (or the classifier was fixed and re-validated until it does); the we-say-substantive-only bucket is characterized with its mapped/unmapped split; disagreement review is written up; `SFEDITS_REQUIRE_DB=1 npm test` still green. **If a cohort cannot reach the 95% directional bar after fixing real bugs, STOP and surface to Louie with the confusion data — do not proceed to Phase 3.**
