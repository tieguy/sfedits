# Shared Wikimedia API Client Module (`lib/mw-api.js`) Design

Linear: LUI-94. Target branch: `integration`.

## Summary

`lib/mw-api.js` centralizes every Wikimedia-facing HTTP call currently
scattered across roughly 20 hand-rolled `fetch` call sites into one CommonJS
module, so compliance behavior (User-Agent, gzip, `maxlag`, 429/Retry-After
handling, serial-request discipline) is enforced in one place instead of
copy-pasted — or forgotten — per file. It wraps two libraries for the traffic
they cover (**m3api** for the Action API, **m3api-rest** for the MediaWiki
REST compare endpoint) and adds its own compliant fetch helper,
`wmFetch`/`wmFetchJson`, for everything they don't (pageviews, RESTBase
summaries, thumbnails, WDQS). Because m3api is ESM-only and the rest of the
repo is CommonJS, the module contains that boundary internally via a single
lazy `import()`, so no consumer has to change module systems to adopt it.

The rollout is staged so the deployed bot is never at risk: Phase 1 builds and
tests the module with zero consumers, then Phases 2–4 migrate call sites
group by group (bot runtime, then remaining scripts/UA cleanup, then the
ported `reassess.js`), each phase leaving the existing test suite green
before the next begins. A checkpoint after Phase 1 exists specifically to
reconcile this work against an in-flight worktree (`delivery-merge`) that
touches some of the same files, and Phase 5 requires a live, non-posting run
against real Wikipedia traffic before anything ships to the deployed branch.

## Definition of Done

- A new shared client module `lib/mw-api.js` on `integration`, powered by
  m3api + m3api-rest (their ESM-ness contained inside the module), covering the
  Action API (en.wikipedia + Wikidata), the MediaWiki REST compare endpoint, and
  a small compliant fetch helper for endpoints no library covers (pageviews,
  RESTBase page summaries, upload thumbnails). Every request carries: a
  User-Agent built by `lib/user-agent.js`, `Accept-Encoding: gzip`, `maxlag`
  where applicable, and the tested 429/Retry-After semantics from the design
  branch's `apiGet` (rate-limit waits do not consume retry attempts, but are
  bounded by a separate cap).
- All Wikimedia call sites on `integration` migrated onto the module: the bot
  runtime modules (`lib/compare-diff.js`, `lib/diff-page.js`,
  `lib/revdel-check.js`, `lib/watchlist-sync.js`, `lib/wikidata-claim-watch.js`,
  `lib/title-resolver.js`), `public/server.js` (`searchPlaces`), and the three
  `find-*` scripts still shipping the upstream author's User-Agent.
  `lib/sparql.js` gains Retry-After handling; `lib/edit-stream.js` keeps its
  working SSE consumer; `lib/mw-oauth.js` gets its missing User-Agent.
- The current `scripts/reassess.js` (and `test/reassess-api.test.js`) ported
  from `place-bot-platform-design` to `integration`, running on the new module
  instead of its own `apiGet` and hardcoded UA literal.
- Verification: full test suite green with the DB container up
  (`SFEDITS_REQUIRE_DB=1`); a grep for User-Agent literals in `lib/` and
  `scripts/` comes back clean; no parallel fan-out at Wikimedia hosts
  introduced (serial request discipline preserved).
- Out of scope: OAuth/authentication (follow-up issue — the module's design
  must not preclude adding a Bearer token later), `mwn`, `rank.js`/dump-reader
  migration, and any push to `fork/integration` (a push is a live deploy within
  15 minutes and waits for explicit go).

## Glossary

- **m3api**: A JavaScript client library for the MediaWiki Action API, maintained by the Wikidata community. ESM-only; rides Node's native `fetch`.
- **m3api-rest**: A companion library to m3api for calling MediaWiki's newer REST API (`/w/rest.php` endpoints), which m3api itself does not cover.
- **mwn**: A different, more established MediaWiki API client library, considered and rejected here because it lacks REST API support and uses axios instead of native `fetch` (which would break the test suite's nock-based interception).
- **Action API**: MediaWiki's traditional query/edit API (`/w/api.php`), used here against en.wikipedia and Wikidata.
- **MediaWiki REST API**: MediaWiki's newer HTTP API style (`/w/rest.php`), used here for the revision-compare endpoint that renders diffs.
- **RESTBase**: A legacy Wikimedia service (being phased out project-wide) that serves page summaries and other precomputed content over REST; still in use here for page summaries.
- **Session (m3api)**: An m3api object representing a configured connection to one wiki host, carrying shared settings like User-Agent and default parameters; this design caches one per host.
- **`maxlag`**: An Action API parameter that asks the server to delay or reject a request if database replication lag exceeds a threshold, as a politeness/load-shedding mechanism for bots.
- **`formatversion`**: An Action API response-shape option; version 2 (used as this module's default) returns cleaner, more consistent JSON than the legacy version 1 shape some existing code may assume.
- **`errorformat: 'plaintext'`**: An Action API parameter requesting human-readable error messages instead of the API's default structured/wikitext error format.
- **429 / Retry-After**: HTTP status 429 ("Too Many Requests") and the `Retry-After` response header telling a client how long to wait before retrying; this design treats `Retry-After` waits as not counting against the normal retry-attempt budget.
- **`AbortSignal.timeout`**: A built-in JavaScript API for automatically aborting a `fetch` request after a specified duration, used here for request timeouts.
- **WDQS**: Wikidata Query Service, the SPARQL endpoint for querying Wikidata; handled by the existing `lib/sparql.js` module, which this design migrates onto the new transport.
- **SPARQL**: The query language used to query WDQS/Wikidata.
- **nock**: A Node.js library for intercepting and mocking HTTP requests in tests; the test suite relies on nock v14 specifically because it can intercept the global `fetch` API (not just Node's older `http` module).
- **Facade (design pattern)**: A single module that presents a simplified interface in front of more complex underlying subsystems (here, m3api, m3api-rest, and raw fetch) — used in the architecture section to describe `lib/mw-api.js`'s role.
- **PageAssessments**: A MediaWiki extension/API providing WikiProject quality/importance ratings for articles, queried here with pagination (`requestAndContinue`) by `lib/watchlist-sync.js`.
- **EventStreams**: Wikimedia's real-time Server-Sent Events feed of live edits, consumed by `lib/edit-stream.js` to drive the bot.
- **BLP**: "Biography of a Living Person" — a Wikipedia content-policy category this bot flags specially; relevant here because compare-diff fetches BLP-related page properties.
- **Bearer token / Authorization header**: Standard HTTP authentication mechanisms; mentioned as the likely mechanism for a future OAuth follow-up, explicitly out of scope for this design.

## Architecture

`lib/mw-api.js` is a CommonJS **transport facade**: it owns transport and
Wikimedia-compliance behavior, and nothing else. Domain logic (what to ask the
API, how to interpret answers, fail-soft policies) stays in the consumer
modules, which swap their raw `fetch` calls for this module. This mirrors how
`lib/sparql.js` already works for WDQS.

The engine for Action API traffic is **m3api** (v1.x, ESM-only), with
**m3api-rest** for `/w/rest.php` endpoints (the revision-compare call). Both
were chosen over `mwn` because m3api-rest covers the REST API (`mwn` does not),
m3api rides Node's native fetch (nock v14 intercepts it; `mwn` uses axios), and
it is actively maintained by the Wikidata community. No library anywhere covers
pageviews, RESTBase summaries, upload thumbnails, or WDQS transport — those go
through the module's own compliant fetch helper, which ports the
already-tested retry loop from the design branch's `apiGet`.

### Public surface (contract)

```js
// Action API — m3api Session, cached per host
actionSession(host, component)   // → Promise<Session>
//   host: 'en.wikipedia.org', 'www.wikidata.org', or any wiki host at runtime
//   component: name passed to lib/user-agent.js userAgent() (first caller wins per host)

// m3api-rest passthrough, bound to a cached session
restGetJson(host, path, query)   // → Promise<object>  e.g. /v1/revision/A/compare/B

// Endpoints no library covers (pageviews, RESTBase summary, thumbnails, arbitrary GETs)
wmFetch(url, opts)               // → Promise<Response>
wmFetchJson(url, opts)           // → Promise<object>  (adds ok-check + JSON parse)

// opts accepted by wmFetch*/underlying knobs:
// { component, tries, backoffMs, rateLimitWaitMs, maxRateLimitWaits, timeoutMs }
```

### Internal behavior

- **ESM containment:** one lazy `await import('m3api')` / `import('m3api-rest')`
  at first use, cached. The ESM/CJS boundary exists only inside this module;
  every consumer stays CommonJS.
- **Sessions** are cached per host in a Map, constructed with
  `userAgent: userAgent(component)` from `lib/user-agent.js`, default params
  `formatversion: 2, errorformat: 'plaintext'`, `maxlag: 5`, and a raised
  `maxRetriesSeconds` for bulk callers (default 65s is too low for reassess's
  wait-out-sustained-429s behavior, previously 60 × 10s).
- **`wmFetch` retry semantics** are the tested `apiGet` semantics from
  `place-bot-platform-design`: 429/`Retry-After` waits do **not** consume retry
  attempts and are bounded by a separate `maxRateLimitWaits` cap; other
  failures get `tries` attempts with linear backoff. `Retry-After` is
  authoritative when present. `Accept-Encoding: gzip` on every request;
  timeouts via `AbortSignal.timeout`.
- **Serial discipline:** the module never fans out. m3api's automatic request
  combining only merges concurrent compatible calls into one HTTP request —
  it never issues parallel requests.
- **Errors:** m3api's `ApiError` passes through for Action API failures;
  `wmFetch` throws `Error('HTTP <status> …')` after exhausting retries
  (matching what the ported tests assert). Consumers' existing catch blocks
  and fail-soft policies keep working unchanged.
- **OAuth (future, out of scope):** slots in later as a per-session option
  (m3api-oauth2 or an Authorization header at session construction) without
  changing the public surface. Nothing in this design precludes it.

## Existing Patterns

- **`lib/user-agent.js`** is the single UA source (env override via
  `SFEDITS_CONTACT`); every session and `wmFetch` call builds its UA there.
  Component naming follows the existing convention (`compare-diff`,
  `revdel-check`, …).
- **`lib/sparql.js`** is the repo's existing "transport module" precedent —
  one module owning WDQS transport, consumers (`lib/region.js`,
  `lib/rebuild.js`) calling semantic functions. The facade shape follows it.
  sparql keeps its WDQS-specific retryability classification but moves its
  transport onto `wmFetch`, gaining Retry-After honoring and gzip.
- **Retry semantics and tests** come from `place-bot-platform-design`:
  `scripts/reassess.js` `apiGet` and `test/reassess-api.test.js` (four cases:
  429 doesn't burn attempts; Retry-After honored; non-429 gives up after
  `tries`; sustained 429 eventually throws). These become the module's tests.
- **Testing style:** mocha/chai/nock against synthetic hosts, as the existing
  suites do; nock v14 intercepts global fetch (existing suites rely on this).
- **Divergence:** this is the repo's first ESM dependency in the runtime path;
  the dynamic-import containment keeps the repo CommonJS. It is also the first
  shared HTTP layer — previously ~20 call sites each hand-rolled fetch.

## Implementation Phases

### Phase 1: Module + tests
**Goal:** `lib/mw-api.js` exists, fully tested, with no consumers yet.

**Components:**
- `lib/mw-api.js` — facade as specified above
- `package.json` — add `m3api`, `m3api-rest`
- `test/mw-api.test.js` — the four ported retry cases plus UA-header presence,
  gzip-header presence, session caching, and JSON error paths (nock, synthetic
  host)

**Dependencies:** none.

**Done when:** `npm test` green; new tests prove the retry semantics; no
consumer has changed.

**CHECKPOINT after this phase:** pause and assess the in-flight work in
`.worktrees/delivery-merge` before touching consumers — it may touch the same
delivery-path modules Phases 2–3 modify. Reconcile ordering with Louie before
proceeding.

### Phase 2: Bot-runtime consumers
**Goal:** the deployed bot's live path runs on the module.

**Components (each keeps its domain logic and fail-soft behavior):**
- `lib/compare-diff.js` — parent-revision + BLP/pageprops via `actionSession`;
  REST compare via `restGetJson`; summary + thumbnails via `wmFetchJson`/`wmFetch`
- `lib/revdel-check.js`, `lib/title-resolver.js`,
  `lib/wikidata-claim-watch.js` (labels) — Action API via `actionSession`;
  the claim-watch Discord webhook stops sending a Wikimedia UA
- `lib/watchlist-sync.js` — `requestAndContinue` for PageAssessments paging
  (fixes the maxlag-thrown-as-fatal bug); arbitrary `titles_url` stays plain fetch
- `lib/diff-page.js` — `https.get` (no timeout) becomes `wmFetch` with one
- `lib/edit-stream.js` — unchanged (reconnect/resume already works)

**Dependencies:** Phase 1 + checkpoint.

**Done when:** existing consumer suites pass (intercepts updated deliberately
where request details legitimately changed); `SFEDITS_REQUIRE_DB=1 npm test`
green.

### Phase 3: Remaining call sites + UA cleanup
**Goal:** no Wikimedia call on `integration` bypasses the module; no UA
literals anywhere.

**Components:**
- `lib/sparql.js` — transport onto `wmFetch` (keeps WDQS retry classification);
  `lib/region.js`/`lib/rebuild.js` inherit with zero changes
- `public/server.js` `searchPlaces` — module + `userAgent()` (drops literal)
- `scripts/find-articles-in-categories.js`, `scripts/find-categories.js`,
  `scripts/find-translations.js` — drop upstream-author UA literals
- `lib/mw-oauth.js` — gains its missing User-Agent

**Dependencies:** Phase 1 (independent of Phase 2; sequenced after it to keep
diffs reviewable).

**Done when:** `grep -rn "USER_AGENT = '" lib/ scripts/` empty; suite green.

### Phase 4: Port reassess.js from the design branch
**Goal:** the current (longer) `scripts/reassess.js` lives on `integration`,
running on the module.

**Components:**
- `scripts/reassess.js` — design-branch version, `apiGet` and UA constant
  deleted, calls via `actionSession`/`wmFetchJson`
- `scripts/reassess-untagged.js`, `scripts/matrix-untagged.js` — stop importing
  `UA` from reassess; SPARQL copies route through `lib/sparql.js` or `wmFetch`
- `test/reassess-api.test.js` — retired in favor of the Phase 1 module tests
  (or kept as thin integration tests of reassess's usage)

**Dependencies:** Phases 1, 3 (sparql transport).

**Done when:** suite green; `node scripts/reassess.js <stage>` still resumes
from `data/reassess/*.json` checkpoints; no `rank.js`/dump-reader migration
(out of scope).

### Phase 5: Live verification
**Goal:** real-Wikipedia-data proof, per Louie's workflow rule.

**Components:** no new code.
- `node page-watch.js --noop --verbose` against live EventStreams; confirm
  `✓ Watchlist sync: N articles` and diff rendering end-to-end
- manual `captureDiffImage` run against a real diff URL; view the PNG
- confirm serial discipline: no new `Promise.all` at Wikimedia hosts
  (grep + review)

**Dependencies:** Phases 2–4.

**Done when:** live run posts nothing (noop) but processes real edits cleanly;
Louie reviews before any push to `fork/integration` (a push deploys within
15 minutes — explicit go required).

## Additional Considerations

**Delivery-merge worktree:** `.worktrees/delivery-merge` holds in-flight work
that may overlap Phases 2–3 files. The Phase 1 checkpoint exists so merge
order is a decision, not an accident.

**Response-shape risk in migration:** sessions default to `formatversion: 2`;
any call site currently relying on formatversion 1 shapes must either keep its
format explicitly or update its parsing deliberately during migration. The
existing nock suites are the guard: intercepts are updated only where a request
legitimately changed.

**m3api retry cap:** `maxRetriesSeconds` defaults to 65s — fine for the bot's
interactive-ish calls, too low for bulk reassess stages. Bulk callers pass a
raised value; the module exposes the knob rather than hardcoding two modes.

**Known m3api limitation:** no documented per-request Authorization header;
the OAuth follow-up will use m3api-oauth2 or session-construction options.
If neither works, the fallback is Bearer via `wmFetch` for authenticated bulk
reads — the public surface doesn't change either way.
