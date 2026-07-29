# Plan A execution state

Working notes for resuming `/ed3d-plan-and-execute:execute-implementation-plan` on this
plan. Written 2026-07-23, updated 2026-07-29. Delete when Plan A is finished.

**Worktree:** `.worktrees/place-bot-platform`, branch `place-bot-platform`.
Nothing has been pushed. All commits are local.

**Standing instruction from Louie (2026-07-29): this is MVP/POC, not perfection.**
Prefer the smallest thing that works and is tested over the thorough version.

## Where things stand

| Phase | Task | Status |
|---|---|---|
| 1 | 1–7 (geo dep → strategy dispatch) | done |
| 1 | chunking → unchunked + size guard | **done, live-verified** |
| — | boundary resolution (unplanned sub-plan) | **done** |
| 2 | topic store on ToolsDB | **in progress (started 2026-07-29)** |
| 3–5 | rebuild job, bot wiring, delivery | not started |
| 6 | Wikimedia OAuth | `lib/mw-oauth.js` spike only, **not wired** |

Test suite: **352 passing, 1 pending, 0 failing** (2026-07-29).
Run `npm test`. Verify the *delta*, never an absolute number.

### The boundary-resolution detour (2026-07-24 → 07-25)

Phase 1's geo strategy hard-failed on any place without a P402 (OSM relation) — which
includes the flagship Mission District. Rather than block on contributing a boundary to
OSM (shelved), a sub-plan was designed and built:
`docs/design-plans/2026-07-24-boundary-resolution.md`, implemented as `resolveBoundary`
in `lib/region.js` with three tiers — **self** (own P402) → **container** (P131 parent's
boundary, returns `needsConfirmation`) → **radius** (centroid + radius, `approximate`).
The geo path routes through it and the admin console surfaces the suggestion.

### The OAuth spike (2026-07-25)

`lib/mw-oauth.js` + `test/mw-oauth.test.js` implement the Wikimedia OAuth 2.0 identify
flow (`authorizeUrl` / `exchangeCode` / `fetchProfile`). This is **Phase 6 work done out
of order** and nothing imports it. Leave it parked; Phase 7's web flow is its first
consumer.

Phase 1's live-data verification has been **run and passes** — see below.

## RESOLVED (2026-07-24): chunking replaced by unchunked query + size guard

The city-scale blocker below turned out to be moot once the *actual* first use cases were
measured live. New Zealand (Q664) — the flagship small-country case — runs its whole
P131* closure in one query in ~4–5 s; the catastrophic 2151-query case was SF-*as-a-city*,
which is out of scope (so is the USA). So `articlesByAdmin` and `regionHistogram` no
longer chunk on sub-entities at all: **one unchunked query anchored at `region.qid`**,
and a WDQS **timeout is translated into a clear "region too large / out of scope" error**
(`runRegionQuery` + `isTimeout` in `lib/region.js`). No magic ceiling — the USA closure
cannot even be *counted* inside 60 s, so a timeout is itself the scale signal.

`subEntities()` and the `onChunkError` option were removed (dead after this change).
`sparqlChunked` stays in `lib/sparql.js` with its tests but is now unused — kept as the
documented claim-watcher chunking pattern per Louie's "chunk machinery stays" call.

Live verification 2026-07-24, through the real code path:
| | Result |
|---|---|
| `resolveRegion(Q664)` | admin strategy |
| `regionHistogram(NZ)` | 10,398 cells, total 58,657, partial=false, **5.1 s** |
| `articlesForRegion(Q664, en)` | 7,985 articles, **5.2 s** |
| `articlesByAdmin(Q30 / USA)` | throws the scope error after 60 s ✓ |

Decisions recorded in Claude memory: `place-bot-region-scale-scope` (updated) and
`place-bot-neighborhood-boundary` (new).

**Still open for Phase 2 (downstream sizing):** the histogram is ~10k cells for NZ, not
"a few hundred" as the plan predicted. Phase 2 storage and Phase 4 serving must size for
10^4 cells, not 10^2.

**Separate gated track — the Mission District has no OSM boundary.** The flagship
neighborhood (Q7469) is a *point* in OSM (no P402, no relation; Nominatim has no polygon
either), so the geo strategy's boundary filter has no data. Louie chose to **contribute a
boundary to OSM** — an outward-facing data task to prepare-and-present before editing, not
a code change (the geo path already works once P402 + a relation exist). Do **not** block
Phase 2 / NZ on it. See `place-bot-neighborhood-boundary` memory.

## Contracts added during review that the plan text does not describe

These came out of code review, not the plan. Later tasks must use them.

1. **`lib/region.js` exports `assertQid(qid, what)` and `assertLang(code)`.**
   - `assertQid` throws unless `/^Q[1-9]\d*$/`. Apply to **config-derived input** only.
   - `assertLang` throws unless `/^[a-z]{2,}(-[a-z0-9]+)*$/i`. Subtag length is
     deliberately unbounded — `simple`, `tokipona`, `zh-classical` are all live wikis.
     The anchored `[a-z0-9-]` alphabet is the injection guard; length never was.
   - **Do not apply these to data returned by WDQS.** Filter with `QID.test(...)`
     instead. A P31 "unknown value" snak renders as a bnode and would otherwise abort a
     whole region that had a perfectly good class in an adjacent row. This distinction
     was gotten wrong once and caught in review; the rule is: *throw on input, filter on
     output.*

2. **`subEntities(regionQid)` returns `{ subs, filtered }`, NOT a bare array.**
   `const subs = await subEntities(...)` silently yields `subs.length === undefined`,
   so the `subs.length > 0` guard is false and the caller degrades to one unchunked
   whole-region query — the exact WDQS timeout the chunking exists to prevent.
   `filtered` is the count of rows dropped by the QID filter; warn when
   `subs.length === 0 && filtered > 0`. The Task 6 snippet in `phase_01.md` has been
   corrected to match.

3. **`lib/osm-boundary.js` does ring stitching and hole association.** The plan's
   version was broken — real OSM splits one boundary ring across many open ways (SF
   relation 111968 returns 19, none individually closed). `stitchRings(ways, role)`
   takes a role: unclosable **outer** rings throw, unclosable **inner** rings warn and
   are dropped individually. Holes are matched to the outer ring that contains them.

4. **`lib/sparql.js` `isRetryable` retries 429**, which the plan's code omitted despite
   its own prose requiring it. 4xx other than 429 deliberately does **not** retry — a
   400 malformed query is deterministic and retrying only burns WDQS budget.

## Defects in the plan document itself — expect more

Verify plan code against reality before copying it. Found so far:

- **nock body matchers.** The plan writes `decodeURIComponent(String(body))`. nock v14
  hands the matcher the **parsed form body**, so this throws
  `TypeError: Cannot convert object to primitive value`. Use `body.query`. This
  appeared at `phase_01.md:170` and `:756`; grep each new phase for `String(body)`
  before dispatching.
- **`fetchBoundary`** assumed one way per ring and discarded `role: 'inner'`. Both wrong
  against live data.
- **Phase 2 assumes Docker.** This machine has **no docker** — `podman` 5.8.4 is present
  and usable. `scripts/test-db.sh` is written against podman.
- **Phase 2's test glob trap is real** — `test/**/*.js` is unquoted in `package.json`, so
  the first `.js` file under a `test/` subdirectory silently reduces the suite to that one
  file while still reporting green. Task 1 Step 3 fixes it; do it before creating
  `test/helpers/`.

## Process notes

- **Every issue gets fixed, including Minors** — this plan's gate is zero issues, not
  "approved". Minors have repeatedly been the thread that led to real bugs (chasing one
  found the rejected-`simple` regression).
- **Do not trust a fixer agent's mutation claims.** Three separate reports asserted
  guards were load-bearing when independent re-runs showed they survived. Re-run the
  mutation yourself, or have the reviewer do it. This is the single highest-value habit
  in this execution.
- **Watch for `try { ...; assert.fail(msg) } catch (e) { assert.include(e.message, x) }`.**
  `assert.fail` throws *inside* the try, the catch swallows it, and the test passes when
  `msg` happens to contain `x`. This hid an unfixed Critical for a full cycle. Use
  `const err = await fn().then(() => null, e => e)`. Also note `assert.isNotNull(undefined)`
  **passes** — initialise capture vars to `null`.
- **Test names must describe what the body asserts.** Five mismatches were found in
  Phase 1 alone.

## Operational risks worth raising with Louie before deploy

- Live Overpass fetches took **50–55 s** against `TIMEOUT_MS = 60000`, and
  `overpass-api.de` returned 504 twice (a mirror was needed). The margin is thin for a
  Toolforge job.
- `lib/sparql.js` uses User-Agent `sfedits-region/1.0`, replacing the claim watcher's
  own. WDQS budgets per (IP, User-Agent), so the claim watcher and region resolver now
  share one 60 s/min bucket instead of having separate ones. Plan-specified and
  consistent, but it halves effective headroom once the resolver ships.
