# Delivery Merge Implementation Plan — Phase 2: Remove Puppeteer/Chromium

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** satori+resvg becomes the only renderer; Puppeteer and every workaround for it disappear.

**Architecture:** `lib/diff-image.js` currently tries `renderDiffModelToFile()` (native), then falls back to `browser().takeHtmlScreenshot()`, then `browser().takeScreenshot()` (`lib/diff-image.js:64–105`, `browser()` at 30–36). The fallback chain and `lib/screenshot.js` are deleted; `captureDiffImage(diffUrl, page)` keeps its contract (returns `{screenshot, altText, summary, article}` or `null`).

**Tech Stack:** satori, @resvg/resvg-js.

**Scope:** Phase 2 of 7. Independent of Phase 1 (but run after it to keep line numbers predictable).

**Codebase verified:** 2026-08-02 (investigator, delivery-merge worktree @ 815b016).

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge`.

---

### Task 1: Remove the fallback path from lib/diff-image.js

**Files:**
- Modify: `lib/diff-image.js`
- Delete: `lib/screenshot.js`

**Step 1: Edit `lib/diff-image.js`:**

1. Remove the `browser()` lazy-loader (lines 30–36) and its require of `./screenshot`.
2. In `captureDiffImage` (64–105): keep the native `renderDiffModelToFile()` path; where the code currently falls back to `browser().takeHtmlScreenshot()` (78–82) and `browser().takeScreenshot()` (100–104), log the native-render error (`console.error('diff render failed:', err.message)`) and return `null`. Callers already handle `null` (posting is skipped).

**Step 2: Delete the module**

```bash
git rm lib/screenshot.js
```

**Step 3: Verify no dangling requires**

```bash
grep -rn "screenshot')\|require('puppeteer')\|require(\"puppeteer\")" lib/ admin/ public/ scripts/ page-watch.js | grep -v node_modules
```

Expected: no hits (note: variables *named* `screenshot` remain everywhere — only the module require goes).

### Task 2: Remove the dependency and build workarounds

**Files:**
- Modify: `package.json` (line 18: remove `"puppeteer": "^24.2.1"`)
- Modify: `.npmrc` (remove the `puppeteer_skip_download=true` line and its comment)
- Modify: `Dockerfile` (lines 5–23) and `admin/Dockerfile` (lines 6–22): remove the Chromium system packages — **read the RUN block first** and keep any package satori/resvg or other code needs (fonts stay if the renderer loads system fonts; check `lib/diff-render-native.js` for font file paths before removing font packages)
- Modify: `docker-compose.yml` (update the Puppeteer/Chromium memory-limit comment)
- Modify: `test/test.js` (remove the `it.skip('works (requires Chrome/Puppeteer)')` test)

**Step 1: Apply the edits, then reinstall**

```bash
npm install 2>&1 | tail -3
```

Expected: succeeds **without** `PUPPETEER_SKIP_DOWNLOAD` (no Chromium download attempted). `package-lock.json` updates.

**Step 2: Verify puppeteer is gone from the tree**

```bash
grep -in puppeteer package.json package-lock.json .npmrc Dockerfile admin/Dockerfile docker-compose.yml 2>/dev/null | head
```

Expected: no hits.

### Task 3: Verify rendering end-to-end and commit

**Step 1: Run the suite**

```bash
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
```

Expected: green (rendering tests use the native path already).

**Step 2: Manual pipeline check against a real diff** (serial, one request; UA comes from `lib/user-agent.js`):

```bash
node -e "
const { captureDiffImage } = require('./lib/diff-image');
captureDiffImage('https://en.wikipedia.org/w/index.php?diff=prev&oldid=1230000000', 'Test')
  .then(r => console.log(r ? 'PNG at ' + r.screenshot : 'null (acceptable only if the diff URL is stale)'));
"
```

Expected: a PNG path; open it and confirm it renders a diff. If the hardcoded oldid is stale, pick a recent revision from https://en.wikipedia.org/wiki/Special:RecentChanges via `wm-fetch`.

**Step 3: Commit**

```bash
git add -A
git commit -m "feat!: remove Puppeteer/Chromium fallback; satori+resvg is the only renderer

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Phase done when:** `npm install` runs clean with no skip-download env var, the manual render check produces a correct PNG, suite is green.
