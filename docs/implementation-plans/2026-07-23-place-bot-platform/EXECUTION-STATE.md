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
| 2 | 1–5 (driver → watch index) | **done 2026-07-29** |
| 3 | 1–3 (title resolver → rebuild job) | **done 2026-07-29** |
| 4 | 1–3 (topic index → fan-out → config) | **done 2026-07-29** |
| 5 | 1–4 (rate cap → quarantine → docs) | **done 2026-07-29** |
| 6 | Wikimedia OAuth | `lib/mw-oauth.js` spike only, **not wired** |
| 7–9 | web flow, BYO-auth, guardrails | design only, no implementation plan |

**Plan A (Phases 1–5) is code-complete.** Phases 6–9 are Plan B, which the design
plan says to write only after the go/no-go below.

Test suite: **456 passing, 1 pending, 0 failing** with the test database up
(`npm run test:db:start`); **405 passing, 52 pending** with it down. Both are green.
Run `npm test`. Verify the *delta*, never an absolute number.

**One unexplained intermittent failure.** Two full-suite runs out of roughly forty on
2026-07-29 reported `1 failing` without the failure text being captured; ~35 targeted
re-runs (including back-to-back and piped invocations) never reproduced it, so which
test it was is unknown. Capture `npm test` to a file rather than piping to `grep` so the
next occurrence is diagnosable.

### Phase 2 as built (differs from the plan in two small ways)

- The migration runner lives in **`lib/db.js`**, not in the test helper, so the rebuild
  job and webservice apply migrations by the same path the tests do.
  `test/helpers/db-helper.js` is now only `describeWithDb` / `truncateAll` / `testDsn`.
- The plan deliberately left `connectionOptions` and `parseJsonColumn` tests red at the
  end of Task 3. Those tests were moved to Task 4 instead; no task ends red.

Also worth knowing downstream: `setTopicArticles` does **not** bump the generation when a
rebuild changes nothing, so an idle rebuild does not force every bot to reload its index.

### Phases 3–5 as built (deviations from the plan text)

- **Phase 3, `siteToWikipedia`.** The plan's regex `/^([a-z_]+)wiki$/` maps `commonswiki`
  to a "commons" Wikipedia, so File: pages would enter a place feed. Sister projects are
  now denied by name (`NON_WIKIPEDIA_SITES`).
- **Phase 3, `defaultResolver`.** The plan passed `onChunkError`, which Phase 1 removed
  along with chunking. The resolver now refuses a `needsConfirmation` result instead —
  a geo region with no boundary of its own resolves to a *container* (a whole city
  standing in for a neighborhood), which is a human's call, not a nightly job's. The
  error names the suggested container.
- **Phase 3, plan QID wrong.** The manual check names `Q1917571` as the Mission District;
  that is Mehrow, a German village. The Mission District is `Q7469`, which resolves
  correctly in en and es.
- **Phase 5, webhook allowlist.** Kept as the plan specifies — https only, to the four
  Discord hosts, path under `/api/webhooks/`, checked at delivery rather than only at
  insert. This is the SSRF guard for URLs strangers type; do not relax it in Phase 8,
  extend it.

### What is NOT verified (needs Louie, both outward-facing)

- **Phase 4/5 live end-to-end.** Seeding two subscriptions on one topic, running the bot
  for real, and confirming both channels get the post with the rich embed intact, one
  render, and that deleting a webhook flips the row to `broken` after five edits. This
  posts to real Discord channels, so it waits for an explicit go.
- What *was* verified live: a seeded topic reaches a running bot's index
  (`Topic index: 2 titles across 1 topics`), the bot starts unchanged with no
  `topic_store` stanza, `scripts/rebuild-topics.js gc` works against a real database, and
  `titlesForQidsViaApi` returns real current titles in en and es.

## GO/NO-GO for Plan B — measured 2026-07-29, and the answer is NO-GO

The design plan says to run the scale check before writing Plan B. Numbers, live:

| Region | Strategy | Result | Time |
|---|---|---|---|
| California (Q99) | admin | 26,914 cells, **211,590 articles**, partial=false | 15.8 s |
| San Mateo County (Q108101) | **geo** | **13 articles** | 6.9 s |

**The county number is the blocker, and it is wrong rather than slow.** San Mateo
County's P31 is `Q131427665` ("charter county of California"), which is not in
`ADMIN_CLASSES` — that set matches *direct* P31 membership only, with no P279 subclass
walk. So the county falls through to the geo strategy, where `articlesByGeo` seeds from
`DEFAULT_SEED_RADIUS_KM = 5` around the centroid and returns 13 articles against a design
estimate of ~10⁴. It does not error, does not warn, and does not set `approximate` (a
self-boundary was found, so the radius seed is trimmed to a polygon that is far larger
than the seed). **A silently plausible wrong answer is the failure mode a web form must
not have**, and Phase 7 is exactly that web form.

Two things to settle before Plan B:

1. **Admin detection must walk P279***, or the flat class set will keep missing regions
   as Wikidata refines its class hierarchy — this is not a one-off bad QID.
2. **The geo radius seed must not silently under-return.** Either derive the radius from
   the boundary's bounding box, or refuse when the boundary is much larger than the seed.

California is the other half: 211,590 articles resolves cleanly in 16 s, so the resolver
will happily hand a stranger a 10⁵-article firehose. Phase 5's per-subscription rate cap
is currently the *only* thing standing between that and a subscriber's Discord channel;
Phase 9's region-size cap is not optional.

Overpass flakiness also recurred: the first San Mateo attempt died on a 504 from
`overpass-api.de` and succeeded on retry, matching the operational risk noted below.

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
