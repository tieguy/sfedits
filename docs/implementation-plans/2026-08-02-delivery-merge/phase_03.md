# Delivery Merge Implementation Plan — Phase 3: Config split (LUI-108, no back-compat)

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** Non-secret config in a committed `config.base.json`; the four secrets in individual env vars; `SFEDITS_CONFIG` support deleted.

**Architecture:** `lib/config.js` composes three layers: `config.base.json` (committed) → `./config.json` (gitignored local overlay, optional) → secret env vars (`SFEDITS_BLUESKY_PASSWORD`, `SFEDITS_MASTODON_ACCESS_TOKEN`, `SFEDITS_DISCORD_WEBHOOK_URL`, `SFEDITS_INVITE_CODES`). Deep-merge; each layer overrides only what it sets. Verified: only `lib/config.js:43` reads `SFEDITS_CONFIG` today; callers are `page-watch.js:36/61`, `admin/server.js:72–78` (which has a redundant `process.env.SFEDITS_CONFIG` check to delete), `public/server.js:25`, and `test/config.test.js`.

**Scope:** Phase 3 of 7. Run after Phase 1 (PII stanzas already gone from the template).

**Codebase verified:** 2026-08-02 (investigator, delivery-merge worktree @ 815b016).

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge`.

**Secret → config-path mapping** (single-account config; secrets apply to `accounts[0]`, and only when the corresponding stanza exists in the base — an env var without its stanza is a startup error, not a silent no-op):

| Env var | Config path |
|---|---|
| `SFEDITS_BLUESKY_PASSWORD` | `accounts[0].bluesky.password` |
| `SFEDITS_MASTODON_ACCESS_TOKEN` | `accounts[0].mastodon.access_token` |
| `SFEDITS_DISCORD_WEBHOOK_URL` | `accounts[0].discord.webhook_url` |
| `SFEDITS_INVITE_CODES` (comma-separated) | `web.invite_codes` |

---

### Task 1: New test file for the overlay loader

**Files:**
- Modify: `test/config.test.js` (rewrite; current file is 8 tests of the old precedence)

**Step 1: Rewrite `test/config.test.js`.** Keep the tmpdir beforeEach/afterEach pattern already in the file. Tests to write (each following the existing chai `assert` style):

1. loads `config.base.json` from an explicit `baseDir`
2. throws a clear error when `config.base.json` is missing
3. local `config.json` overlay overrides scalar values from base and deep-merges objects (e.g. base has `accounts[0].collapse.window_minutes: 15`, overlay sets `accounts[0].collapse.enabled: false`, both survive)
4. overlay leaves base untouched where the overlay is silent
5. `SFEDITS_BLUESKY_PASSWORD` lands at `accounts[0].bluesky.password`
6. `SFEDITS_MASTODON_ACCESS_TOKEN` lands at `accounts[0].mastodon.access_token`
7. `SFEDITS_DISCORD_WEBHOOK_URL` lands at `accounts[0].discord.webhook_url`
8. `SFEDITS_INVITE_CODES="a,b"` lands as `['a','b']` at `web.invite_codes`
9. a secret env var whose stanza is absent from the composed config throws (names the var)
10. `SFEDITS_CONFIG` in env is **rejected with an error telling the operator it is no longer supported** (a silently-ignored stale secret blob is worse than a crash)
11. env secrets override values set by base/local for the same path
12. `topic_store` stanza passes through untouched (port of the existing test)

Signature under test: `loadConfig({ baseDir = process.cwd(), env = process.env } = {})` — tests pass a tmpdir `baseDir` containing fixture `config.base.json` / `config.json` files and an explicit `env` object.

**Step 2: Run to verify they fail**

```bash
npx mocha test/config.test.js 2>&1 | tail -5
```

Expected: failures (new API doesn't exist yet).

### Task 2: Rewrite lib/config.js

**Files:**
- Modify: `lib/config.js`

**Step 1: Replace the implementation:**

```javascript
const fs = require('fs')
const path = require('path')

const SECRETS = [
  { env: 'SFEDITS_BLUESKY_PASSWORD',       stanza: c => c.accounts?.[0]?.bluesky,  set: (c, v) => { c.accounts[0].bluesky.password = v } },
  { env: 'SFEDITS_MASTODON_ACCESS_TOKEN',  stanza: c => c.accounts?.[0]?.mastodon, set: (c, v) => { c.accounts[0].mastodon.access_token = v } },
  { env: 'SFEDITS_DISCORD_WEBHOOK_URL',    stanza: c => c.accounts?.[0]?.discord,  set: (c, v) => { c.accounts[0].discord.webhook_url = v } },
  { env: 'SFEDITS_INVITE_CODES',           stanza: c => c.web,                     set: (c, v) => { c.web.invite_codes = v.split(',').map(s => s.trim()).filter(Boolean) } }
]

function deepMerge(base, overlay) {
  if (Array.isArray(overlay) || typeof overlay !== 'object' || overlay === null) return overlay
  if (typeof base !== 'object' || base === null || Array.isArray(base)) base = {}
  const out = { ...base }
  for (const [k, v] of Object.entries(overlay)) out[k] = deepMerge(base[k], v)
  return out
}

function loadConfig({ baseDir = process.cwd(), env = process.env } = {}) {
  if (env.SFEDITS_CONFIG) {
    throw new Error('SFEDITS_CONFIG is no longer supported. Config now comes from ' +
      'config.base.json plus the SFEDITS_* secret env vars — see docs/deploy-toolforge.md.')
  }
  const basePath = path.join(baseDir, 'config.base.json')
  if (!fs.existsSync(basePath)) throw new Error(`missing ${basePath}`)
  let config = JSON.parse(fs.readFileSync(basePath, 'utf8'))

  const localPath = path.join(baseDir, 'config.json')
  if (fs.existsSync(localPath)) {
    config = deepMerge(config, JSON.parse(fs.readFileSync(localPath, 'utf8')))
  }

  for (const s of SECRETS) {
    const value = env[s.env]
    if (value === undefined || value === '') continue
    if (!s.stanza(config)) throw new Error(`${s.env} is set but the config has no stanza for it`)
    s.set(config, value)
  }
  return config
}

module.exports = { loadConfig }
```

Preserve anything else the current file does that isn't source selection (the ranges-file resolution the old tests mention — grep the current file for it and keep that logic, applied after composition).

**Step 2: Run the new tests**

```bash
npx mocha test/config.test.js 2>&1 | tail -5
```

Expected: all pass.

### Task 3: Create config.base.json and update callers

**Files:**
- Create: `config.base.json` (committed)
- Modify: `page-watch.js` (~36, 61, and the third site at ~650 `const config = getConfig(argv.config)` — remove the `--config` CLI flag from the arg parsing and usage text; `loadConfig({path})` no longer exists), `admin/server.js` (72–78), `public/server.js` (~25 and its call site), `scripts/send-alert.js:16`, `scripts/migrate.js:32`, `scripts/rebuild-topics.js:49`
- Modify: `README.md:49` and `README.md:96` — both say `cp config.json.template config.json`; replace with the new local-overlay instruction ("secrets go in `config.json` (gitignored) or env vars; non-secret config is `config.base.json`")
- Delete: `config.json.template`
- Modify: `.gitignore` (ensure `config.json` still ignored; add nothing for `config.base.json`)

Note on the script callers: `scripts/migrate.js` and `scripts/rebuild-topics.js` use the no-arg form, so after this change they resolve `config.base.json` from `process.cwd()`. Both run from the repo root in the Toolforge image (Procfile entries), so this is fine — but state it in the commit message so the behavior change is on record.

**Step 1: Build `config.base.json`** from the post-Phase-1 `config.json.template`, minus the four secret values (leave the stanzas present with the secret **keys absent**, e.g. `"bluesky": { "identifier": "sfedits.bsky.social" }`). Copy real non-secret values from the local `config.json` in the main checkout **only after reading it and confirming each copied value is non-secret** (the operator's actual template string, watchlist_source, topic_store hosts, `web.max_articles`). Never copy `password`, `access_token`, `webhook_url`, `invite_codes`, or `pii_*` values.

**Step 2: Update callers** to the new signature: replace path/env plumbing with `loadConfig()` (or `loadConfig({ baseDir })` where the process runs outside the repo root — `admin/server.js` resolves relative to `__dirname/..`). Delete `admin/server.js`'s redundant `process.env.SFEDITS_CONFIG` branch. Grep for `CONFIG_PATH` and remove its handling.

```bash
git rm config.json.template
```

**Step 3: Local dev bridge.** Create a local overlay in the **worktree only** (do not commit): copy the secret fields from the main checkout's `config.json` into `.worktrees/delivery-merge/config.json` so local runs still authenticate. Verify `git status` does not list it.

**Step 4: Full suite + grep**

```bash
SFEDITS_REQUIRE_DB=1 npm test 2>&1 | tail -5
grep -rn "SFEDITS_CONFIG" --include='*.js' lib/ admin/ public/ scripts/ page-watch.js | grep -v 'no longer supported'
```

Expected: suite green; grep shows only the rejection message in `lib/config.js`.

**Step 5: Verify no secrets staged**

```bash
git diff --cached --stat; git diff --cached | grep -in "password\|access_token\|webhook_url\|invite_codes" | grep -v '""\|base.json.*{}'
```

Read every hit before committing — key names are fine, values are not.

**Step 6: Commit**

```bash
git add -A
git commit -m "feat!: split config — committed config.base.json + four secret env vars (LUI-108)

SFEDITS_CONFIG is rejected with a pointer to the new scheme.

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

**Phase done when:** loader tests prove precedence and each secret path, no secret value appears in any committed file, suite green.
