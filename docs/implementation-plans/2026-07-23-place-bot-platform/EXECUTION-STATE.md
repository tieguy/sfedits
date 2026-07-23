# Plan A execution state

Working notes for resuming `/ed3d-plan-and-execute:execute-implementation-plan` on this
plan. Written 2026-07-23. Delete when Plan A is finished.

**Worktree:** `.worktrees/place-bot-platform`, branch `place-bot-platform`.
Nothing has been pushed. All commits are local.

## Where things stand

| Phase | Task | Status |
|---|---|---|
| 1 | 1 — geo dependency | done |
| 1 | 2 — shared SPARQL helper | done |
| 1 | 3 — region descriptor | done |
| 1 | 4 — admin containment | done |
| 1 | 5 — geo containment | done |
| 1 | 6 — count histogram | **next** |
| 1 | 7 — strategy dispatch | not started |
| 2–5 | all | not started |

Test suite: **244 at baseline → 327 passing, 1 pending, 0 failing.**
Run `npm test`. Verify the *delta*, never an absolute number.

Phase 1's live-data verification block (bottom of `phase_01.md`) has **not** been run
yet — it needs Task 7's `articlesForRegion`. Do it before starting Phase 2.

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
- **Phase 2 assumes Docker.** This machine has **no docker** — `podman` is present and
  usable. `scripts/test-db.sh` must be written against podman or detect at runtime.

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
