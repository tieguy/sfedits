# Substantive-Edit Filter Implementation Plan — Phase 1: Classifier Module

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** `lib/edit-significance.js` — a pure module answering "did this edit change what a reader sees?" from two wikitexts, with fixture tests.

**Architecture:** wtf_wikipedia parses both revisions; named "channels" (prose, infobox-values, references, media, headings, template-bag, links, categories, external-links) are extracted from each parse and compared. Any changed channel whose policy is `substantive` makes the edit substantive. No network, no config, no delivery knowledge.

**Tech Stack:** Node 22 (CommonJS), wtf_wikipedia ^10.4.2 (already a dependency), mocha + chai `assert`, filesystem fixtures.

**Scope:** 5 phases from `docs/design-plans/2026-08-14-substantive-edit-filter.md` (this file: phase 1).

**Codebase verified:** 2026-08-14 (two codebase-investigator passes, this branch).

**Working directory:** `.worktrees/substantive-edit-filter` (branch `substantive-edit-filter`). All paths below are relative to that worktree root. Run `npm test` from the worktree root; the shared MariaDB test container on :3307 should already be up (do NOT run `test:db:stop`).

---

### Task 1: Wikitext-pair fixtures

**Files:**
- Create: `test/fixtures/wikitext-pairs/` (new directory; `test/fixtures/diff-html/` is the existing sibling pattern)
- Create: the `.txt` files below

Every pair is `<name>.before.txt` / `<name>.after.txt`. The shared base article is:

`test/fixtures/wikitext-pairs/base.before.txt` — used as the `before` side of most pairs:

```
'''Testville''' is a city in [[Example County]]. {{Infobox settlement|name=Testville|population=1000}} It has a long [[history]].<ref>{{cite web|url=http://a.example.com|title=City records}}</ref>

== History ==
Founded long ago near the [[Green River]]. [[File:oldtown.jpg|thumb|Old town]]

[[Category:Cities]]
```

**Step 1: Create the files**

Create `base.before.txt` with the content above, then create each `after` file as a copy of `base.before.txt` with exactly the stated change:

| File | Change vs `base.before.txt` |
|---|---|
| `prose-change.after.txt` | `Founded long ago near` → `Founded in 1850 near` |
| `whitespace-only.after.txt` | `is a city in` → `is  a city in` (double space); add two trailing spaces at the end of the `Founded…` line; and insert a blank line before `It has a long`, splitting the intro paragraph in two (a paragraph re-flow with no wording change — the design's whitespace/formatting rule treats it as non-substantive). The paragraph split is the part that actually exercises the prose channel's whitespace normalization: wtf's `text()` preserves paragraph breaks as `\n\n` (verified 2026-08-14), while the double space alone is collapsed by wtf's own extraction |
| `template-only.after.txt` | Insert `{{Use mdy dates|date=August 2026}}` and a following space at the very start of the file |
| `infobox-value.after.txt` | `population=1000` → `population=2000` |
| `category-only.after.txt` | Append a final line `[[Category:Towns in Example County]]` |
| `link-retarget.after.txt` | `[[history]]` → `[[History of Testville|history]]` (rendered text unchanged, link target changed) |
| `ref-added.after.txt` | After the existing `</ref>`, insert `<ref>{{cite news|url=http://b.example.com|title=Anniversary}}</ref>` |

Plus one standalone Spanish pair (not derived from the base):

`es-infobox.before.txt`:
```
'''Villaprueba''' es una ciudad. {{Ficha de localidad|nombre=Villaprueba|población=1000}} Tiene historia.

[[Categoría:Ciudades]]
```

`es-infobox.after.txt`: same, with `población=1000` → `población=2000`.

**Step 2: Verify the fixtures parse**

Run from the worktree root:
```bash
node -e "const wtf=require('wtf_wikipedia'),fs=require('fs');for(const f of fs.readdirSync('test/fixtures/wikitext-pairs')){const d=wtf(fs.readFileSync('test/fixtures/wikitext-pairs/'+f,'utf-8'));console.log(f, 'prose-len', d.text().length)}"
```
Expected: one line per file, no exceptions, every `prose-len` > 0.

**Step 3: Commit**

```bash
git add test/fixtures/wikitext-pairs/
git commit -m "$(cat <<'EOF'
test: wikitext-pair fixtures for the substantive-edit classifier

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

### Task 2: Failing tests for classifyEdit

**Files:**
- Create: `test/edit-significance.test.js`

**Step 1: Write the failing tests**

```javascript
const { describe, it } = require('mocha')
const { assert } = require('chai')
const fs = require('fs')
const path = require('path')

const { classifyEdit, DEFAULT_CHANNELS, MAX_INPUT_CHARS } = require('../lib/edit-significance')

function loadPair(name, beforeName = 'base') {
  const dir = path.join(__dirname, 'fixtures/wikitext-pairs')
  return {
    before: fs.readFileSync(path.join(dir, `${beforeName}.before.txt`), 'utf-8'),
    after: fs.readFileSync(path.join(dir, `${name}.after.txt`), 'utf-8')
  }
}

describe('edit-significance classifyEdit', function () {
  it('flags a prose change as substantive with reason "prose"', function () {
    const { before, after } = loadPair('prose-change')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'prose')
  })

  it('treats a whitespace-only edit as not substantive with no changed channels', function () {
    const { before, after } = loadPair('whitespace-only')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
    assert.deepEqual(v.ignored, [])
  })

  it('treats template-only churn as not substantive, ignored as template-bag', function () {
    const { before, after } = loadPair('template-only')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'template-bag')
  })

  it('flags an infobox value change as substantive with reason "infobox-values"', function () {
    const { before, after } = loadPair('infobox-value')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'infobox-values')
    assert.notInclude(v.reasons, 'prose')
  })

  it('treats a category-only edit as not substantive, ignored as categories', function () {
    const { before, after } = loadPair('category-only')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'categories')
  })

  it('treats a link retarget with unchanged rendered text as not substantive', function () {
    const { before, after } = loadPair('link-retarget')
    const v = classifyEdit(before, after)
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'links')
  })

  it('flags an added reference as substantive with reason "references"', function () {
    const { before, after } = loadPair('ref-added')
    const v = classifyEdit(before, after)
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'references')
  })

  it('returns not-substantive for identical revisions', function () {
    const { before } = loadPair('prose-change')
    const v = classifyEdit(before, before)
    assert.isFalse(v.substantive)
    assert.deepEqual(v.reasons, [])
  })

  it('flags a Spanish infobox value change (Ficha) as substantive', function () {
    const { before, after } = loadPair('es-infobox', 'es-infobox')
    const v = classifyEdit(before, after, { lang: 'es' })
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'infobox-values')
  })

  it('conservative-passes when either side is missing', function () {
    const v = classifyEdit('', 'some text')
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'missing-content')
  })

  it('conservative-passes oversize input without parsing', function () {
    const big = 'x'.repeat(MAX_INPUT_CHARS + 1)
    const v = classifyEdit(big, big)
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'input-too-large')
  })

  it('honors channel policy overrides', function () {
    const { before, after } = loadPair('ref-added')
    const v = classifyEdit(before, after, { channels: { references: 'ignored' } })
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'references')
  })

  it('exports the documented default channel policy', function () {
    assert.equal(DEFAULT_CHANNELS.prose, 'substantive')
    assert.equal(DEFAULT_CHANNELS['template-bag'], 'ignored')
  })

  // Revert symmetry (design: "reverts get no special casing"): a revert of a
  // visible change is itself visible; a revert of gnoming is itself gnoming.
  // classifyEdit takes no tags argument, so revert tags CANNOT influence the
  // verdict — these tests pin the content-only behavior in both directions.
  it('classifies a revert of a prose change as substantive', function () {
    const { before, after } = loadPair('prose-change')
    const v = classifyEdit(after, before) // reverted direction
    assert.isTrue(v.substantive)
    assert.include(v.reasons, 'prose')
  })

  it('classifies a revert of template churn as not substantive', function () {
    const { before, after } = loadPair('template-only')
    const v = classifyEdit(after, before) // reverted direction
    assert.isFalse(v.substantive)
    assert.include(v.ignored, 'template-bag')
  })

  it('conservative-passes with fallback parse-error when parsing throws', function () {
    const proxyquire = require('proxyquire')
    const { classifyEdit: classifyWithBrokenParser } = proxyquire('../lib/edit-significance', {
      wtf_wikipedia: () => { throw new Error('simulated parser failure') }
    })
    const v = classifyWithBrokenParser('some text', 'other text')
    assert.isTrue(v.substantive)
    assert.equal(v.fallback, 'parse-error')
  })
})
```

**Step 2: Run tests to verify they fail**

```bash
npx mocha --colors --reporter spec 'test/edit-significance.test.js'
```
Expected: FAIL — `Cannot find module '../lib/edit-significance'`.

---

### Task 3: Implement lib/edit-significance.js

**Files:**
- Create: `lib/edit-significance.js`

**Step 1: Write the module**

```javascript
/**
 * Substantive-edit classifier: does an edit change what a reader sees?
 *
 * Pure module — two wikitexts in, verdict out. No network, no config files,
 * no delivery knowledge (that separation keeps a later extraction to a
 * standalone package a file move). Design:
 * docs/design-plans/2026-08-14-substantive-edit-filter.md
 *
 * A "channel" is a named slice of the wtf_wikipedia parse, compared across
 * the two revisions. Channel policy decides which changes count:
 * 'substantive' channels decide the verdict; 'ignored' channels are
 * reported but never decide. Whitespace differences never count: prose is
 * whitespace-normalized and every other channel compares parsed structures.
 */
const wtf = require('wtf_wikipedia')

const DEFAULT_CHANNELS = {
  prose: 'substantive',
  'infobox-values': 'substantive',
  references: 'substantive',
  media: 'substantive',
  headings: 'substantive',
  'template-bag': 'ignored',
  links: 'ignored',
  categories: 'ignored',
  'external-links': 'ignored'
}

// Inputs above this size skip parsing entirely and conservative-pass.
// ~1.5MB is several times the largest article on the current watchlist;
// two concurrent parses of pathological pages are an OOM risk (LUI-120).
const MAX_INPUT_CHARS = 1.5 * 1024 * 1024

// JSON.stringify with sorted object keys, so key order never reads as a change.
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

function extractChannels(doc) {
  const sortedJson = list => list.map(stableStringify).sort().join('\n')
  const internalLinks = doc.links().filter(l => l.type() === 'internal')
  const externalLinks = doc.links().filter(l => l.type() === 'external')
  return {
    prose: doc.text().replace(/\s+/g, ' ').trim(),
    'infobox-values': stableStringify(doc.infoboxes().map(i => i.json())),
    references: sortedJson(doc.references().map(r => r.json())),
    media: doc.images().map(i => i.file()).sort().join('\n'),
    // Heading order is meaningful to a reader, so no sort here.
    headings: doc.sections().map(s => s.title()).filter(Boolean).join('\n'),
    'template-bag': sortedJson(doc.templates().map(t => t.json())),
    links: [...new Set(internalLinks.map(l => l.page()).filter(Boolean))].sort().join('\n'),
    categories: doc.categories().slice().sort().join('\n'),
    'external-links': [...new Set(externalLinks.map(l => l.site()).filter(Boolean))].sort().join('\n')
  }
}

/**
 * Classify one edit.
 * @param {string} prevWikitext  parent revision wikitext
 * @param {string} currWikitext  new revision wikitext
 * @param {object} [opts]
 * @param {object} [opts.channels]  per-channel policy overrides
 *   ({channelName: 'substantive'|'ignored'}), merged over DEFAULT_CHANNELS
 * @param {string} [opts.lang]  reserved for language-specific behavior;
 *   wtf_wikipedia's alias tables are multilingual, so parsing needs no flag
 * @returns {{substantive: boolean, reasons: string[], ignored: string[], fallback?: string}}
 *   fallback is set when classification could not run; callers must treat
 *   fallback verdicts as substantive (conservative pass), and they already
 *   are (substantive: true).
 */
function classifyEdit(prevWikitext, currWikitext, { channels, lang = 'en' } = {}) {
  void lang
  const policy = { ...DEFAULT_CHANNELS, ...(channels || {}) }
  const prev = typeof prevWikitext === 'string' ? prevWikitext : ''
  const curr = typeof currWikitext === 'string' ? currWikitext : ''
  if (!prev || !curr) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'missing-content' }
  }
  if (prev.length > MAX_INPUT_CHARS || curr.length > MAX_INPUT_CHARS) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'input-too-large' }
  }
  // Sequential parses on purpose: parsing both concurrently doubles peak
  // memory on large articles. A parse/extraction throw is a fallback, not an
  // exception: the module must honor conservative-pass for ANY caller.
  let before, after
  try {
    before = extractChannels(wtf(prev))
    after = extractChannels(wtf(curr))
  } catch (err) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'parse-error' }
  }
  const reasons = []
  const ignored = []
  for (const name of Object.keys(before)) {
    if (before[name] === after[name]) continue
    if (policy[name] === 'substantive') reasons.push(name)
    else ignored.push(name)
  }
  return { substantive: reasons.length > 0, reasons, ignored }
}

module.exports = { classifyEdit, extractChannels, DEFAULT_CHANNELS, MAX_INPUT_CHARS }
```

**Step 2: Run the new tests**

```bash
npx mocha --colors --reporter spec 'test/edit-significance.test.js'
```
Expected: all 16 tests pass. If a fixture-driven test fails, debug by printing both extractions:
```bash
node -e "const {extractChannels}=require('./lib/edit-significance');const wtf=require('wtf_wikipedia'),fs=require('fs');const p=n=>fs.readFileSync('test/fixtures/wikitext-pairs/'+n,'utf-8');console.log(extractChannels(wtf(p('base.before.txt'))));console.log(extractChannels(wtf(p('template-only.after.txt'))))"
```
Fix the fixture (or, if wtf's parse genuinely differs from the expectation, adjust the *test's expected channel* and note it in the commit message) — do not weaken the classifier to make a fixture pass.

**Step 3: Run the full suite**

```bash
SFEDITS_REQUIRE_DB=1 npm test
```
Expected: baseline 788 + 16 new = 804 passing, 0 failures. (Keep the glob quoted exactly as in package.json.)

**Step 4: Commit**

```bash
git add lib/edit-significance.js test/edit-significance.test.js
git commit -m "$(cat <<'EOF'
feat: substantive-edit classifier (lib/edit-significance.js)

Pure channel-diff classifier over wtf_wikipedia parses: prose, infobox
values, references, media and headings decide; template churn, link,
category and external-link gnoming are reported but ignored. Conservative
fallbacks (missing content, oversize input) always classify substantive.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01FYE5KWyKWGuMYmpu2AiuH9
EOF
)"
```

---

**Phase 1 done when:** `SFEDITS_REQUIRE_DB=1 npm test` is green with the 16 new tests included, and both commits above exist.
