# Delivery Merge Implementation Plan — Phase 4: Edit filter module

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** `lib/edit-filters.js` — the shared filter shape and predicates — plus the missing `minor` flag on edit objects.

**Architecture:** Filter shape `{ bots, minor, min_delta, cosmetic_only }`. Semantics (from the design doc): `bots: false` = drop bot-flagged edits; `minor: false` = drop minor edits; absent/`true` = allow; `min_delta: N` drops |delta| < N; `cosmetic_only: false`(enabled) drops diffs whose every changed line is template/category/ref/whitespace. Two predicates: `passesMetadata(edit, filters)` (stream fields only) and `passesContent(diffHtml, filters)` (uses fetched diff HTML). Conservative bias: uncertain parse ⇒ NOT cosmetic ⇒ post.

**Blocking gap found in verification:** `toEdit()` (`lib/edit-stream.js:75–104`) does not extract `event.minor` — `robot: Boolean(event.bot)` is at line 100, but there is no `minor` field. This phase adds it.

**Scope:** Phase 4 of 7. Independent of Phases 1–3.

**Codebase verified:** 2026-08-02 (investigator, delivery-merge worktree @ 815b016).

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge`.

---

### Task 1: Expose `minor` on edit objects

**Files:**
- Modify: `lib/edit-stream.js` (in `toEdit()`, next to `robot: Boolean(event.bot)` at line 100)
- Test: the existing edit-stream test file (`ls test/ | grep -i "edit-stream\|stream"`; if none exists, add the assertion to whichever test already constructs edits via `toEdit`/EditStream — grep `toEdit` in `test/`)

**Step 1: Write the failing test** — an event with `minor: true` produces an edit with `minor: true`; an event without it produces `minor: false`. Follow the surrounding test file's existing construction style.

**Step 2: Run it, expect failure** (`npx mocha <testfile> 2>&1 | tail -3`).

**Step 3: Implement** — one line in `toEdit()`:

```javascript
minor: Boolean(event.minor),
```

**Step 4: Run the test file — pass. Step 5: Commit** (`feat: expose the minor flag on edit objects`, with the Co-Authored-By trailer used in this repo).

### Task 2: Metadata predicates

**Files:**
- Create: `lib/edit-filters.js`
- Test: `test/edit-filters.test.js`

**Step 1: Write failing tests** for `normalizeEditFilters` and `passesMetadata` (chai assert style):

- null/undefined/`{}` filters pass everything
- `{bots: false}` drops `robot: true` edits, passes `robot: false`
- `{minor: false}` drops `minor: true` edits
- `{min_delta: 100}` drops `delta: 50` and `delta: -50`, passes `delta: 150` and `delta: -150`; passes `delta: null` (unknown size ⇒ post)
- combined filters AND together
- `normalizeEditFilters` fills defaults: `{bots: true, minor: true, min_delta: 0, cosmetic_only: false}` and ignores unknown keys

**Step 2: Run, expect failure. Step 3: Implement:**

```javascript
const DEFAULTS = { bots: true, minor: true, min_delta: 0, cosmetic_only: false }

function normalizeEditFilters(filters) {
  if (!filters || typeof filters !== 'object') return { ...DEFAULTS }
  return {
    bots: filters.bots !== false,
    minor: filters.minor !== false,
    min_delta: Number.isFinite(filters.min_delta) && filters.min_delta > 0 ? filters.min_delta : 0,
    cosmetic_only: filters.cosmetic_only === true
  }
}

// Polarity note: bots/minor are "allowed?" booleans (false = drop that class;
// absent = allow). cosmetic_only is an opt-in switch (true = drop cosmetic-only
// edits; absent/false = off). This matches the design doc's defaults, where the
// SF feeds set {bots: false, minor: false} and cosmetic_only is opt-in.

function passesMetadata(edit, filters) {
  const f = normalizeEditFilters(filters)
  if (!f.bots && edit.robot) return false
  if (!f.minor && edit.minor) return false
  if (f.min_delta > 0 && edit.delta !== null && edit.delta !== undefined &&
      Math.abs(edit.delta) < f.min_delta) return false
  return true
}
```

(`needsContentCheck(filters)` helper: returns `normalizeEditFilters(filters).cosmetic_only` — used by Phase 6 to decide whether the diff stage runs.)

**Step 4: Run — pass. Step 5: Commit.**

### Task 3: Cosmetic-only content classifier

**Files:**
- Modify: `lib/edit-filters.js` (add `isCosmeticOnly`, `passesContent`)
- Test: `test/edit-filters.test.js`
- Fixtures: `test/fixtures/diff-html/*.html` (new directory)

**Step 1: Build fixtures.** The classifier consumes what `fetchDiffHtml` fetches in production — the rendered diff page at `https://en.wikipedia.org/w/index.php?diff=<rev>&oldid=<prev>` (see the fetch at `page-watch.js:422`), **not** the compare-API JSON that `lib/compare-diff.js` uses. Capture fixtures from exactly that URL shape with `wm-fetch` (serial, one at a time), 4–6 samples, and save trimmed versions (just the `table.diff` markup) under `test/fixtures/diff-html/`: a template-only change, a category-only change, a ref-only change, a whitespace-only change, a prose change, a mixed template+prose change. Finding suitable diffs: browse recent changes of a heavily-templated article's history via `wm-fetch`; trimming by hand is fine. Name files by case (`template-only.html`, `prose.html`, …).

**Step 2: Write failing tests:**

- template-only / category-only / ref-only / whitespace-only fixtures ⇒ `isCosmeticOnly` true
- prose and mixed fixtures ⇒ false
- empty string, malformed HTML, HTML with no recognizable diff rows ⇒ false (uncertain ⇒ not cosmetic)
- `passesContent(html, {cosmetic_only: true})` drops cosmetic, passes prose; with `cosmetic_only` absent or false it always passes and must not parse the HTML (pass `null` html to prove it)

**Step 3: Implement.** Extraction: collect the text of `<td class="diff-deletedline">…</td>` and `<td class="diff-addedline">…</td>` cells (regex over `<td[^>]*class="[^"]*diff-(?:deleted|added)line[^"]*"[^>]*>([\s\S]*?)<\/td>`, then strip inner tags and decode entities). Classification per line (trimmed):

- empty ⇒ cosmetic
- `/^\{\{[^{}]*\}\}$/` (a single non-nested template) ⇒ cosmetic
- `/^\[\[(Category|File|Image):[^\[\]]*\]\]$/i` ⇒ cosmetic
- `/^<ref[^>]*>.*<\/ref>$/s` or `/^<ref[^>]*\/>$/` ⇒ cosmetic
- anything else — including nested templates, partial-line changes, and any line the patterns don't wholly match ⇒ NOT cosmetic

`isCosmeticOnly` returns true only when ≥1 line was extracted AND every line classified cosmetic. This is deliberately narrow; do not add brace-matching for nested templates (known trap — `wtf_wikipedia` isn't a dependency on this branch and regex heuristics fail on nesting; a partial match must fail open).

**Step 4: Run — pass. Step 5: Full suite green (`SFEDITS_REQUIRE_DB=1 npm test`), commit** (include fixtures; note `.gitignore` ignores `*.png` but not `.html`, so no exceptions needed).

### Task 4: Collapsed bursts aggregate the filterable fields

Filters run downstream of the collapser (design decision), and `EditCollapser.combine()` is currently `Object.assign({}, last)` (`lib/edit-collapser.js:141–143`) — so `delta`, `robot`, and `minor` on a combined edit reflect only the burst's **last** revision. That makes `min_delta` measure one revision of a five-revision burst and lets one trailing minor edit hide a substantive burst.

**Files:**
- Modify: `lib/edit-collapser.js` (`combine()`)
- Test: `test/edit-collapser.test.js`

**Semantics:** on the combined edit, `delta` = sum of the burst's deltas (null deltas treated as 0, unless every delta is null ⇒ null); `robot` = true only if every constituent was; `minor` = true only if every constituent was. All other fields keep the current last-edit behavior.

**Steps:** failing tests (burst of +50/+80 with `min_delta`-relevant sum 130; burst of [minor, non-minor] ⇒ `minor: false`; all-bot burst ⇒ `robot: true`) → implement → test file green → commit.

**Phase done when:** all edit-filter unit tests pass including the conservative-bias cases, `minor` flows from stream events to edit objects, combined bursts aggregate `delta`/`robot`/`minor`, suite green.
