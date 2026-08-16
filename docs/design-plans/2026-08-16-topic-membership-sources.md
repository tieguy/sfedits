# Topic membership sources design

## Summary

Today a topic is "one Wikidata region plus filters" — enforced by a database
uniqueness constraint on `(region_qid, filters_hash)`. This design replaces
that with a topic being any combination of typed **membership sources**
(a region, a WikiProject, or an arbitrary Wikidata statement pattern) whose
resolved article sets are unioned and then narrowed by filters. That change
is what lets a single topic express things the current model cannot — the
SFBA account's watchlist (nine county regions, the Bay Area item itself,
and a task force), or a topic defined by WikiProject membership instead of
geography — without inventing a general query language: union lives in the
source list, intersection lives in per-article filter predicates, and
nothing else.

Mechanically, the work has three moving parts. First, topic identity moves
from the region-column constraint to a hash over the normalized, sorted
source list plus normalized filters, so "same definition, same topic"
dedup still holds once a topic can have several sources. Second, the
pluggable resolver already present in `lib/rebuild.js` becomes a proper
registry keyed by source type: each source resolves serially into an
article set, the results are unioned with dedup, and a partial or
suspiciously empty resolve refuses the whole rebuild rather than quietly
shrinking a topic's membership. Third, two new resolvers are built behind
that registry — a WikiProject resolver over PageAssessments (membership
only; ratings are dropped) and a Wikidata statement resolver over WDQS —
with WikiProject creation exposed through `/create` and the more general
Wikidata/multi-source case kept operator-only behind a new CLI. Everything
downstream of `topic_articles` — the in-RAM watch index, edit fan-out,
delivery, rate limiting — is untouched, so this is a redesign of how
membership is computed, not of how matched edits get delivered. The work
ships in seven phases, each independently testable and dependent only on
the phase(s) before it.

## Definition of Done

A topic is no longer "a region plus filters". A topic is a set of typed
membership sources plus filters over their union. Concretely:

- A topic can be defined by any union of `region`, `wikiproject`, and
  `wikidata` source rows. Membership is the deduplicated union of each
  source's resolve, with the topic's filters applied.
- Topic identity (the dedup rule "identical definitions share one topic")
  is a hash over the sorted, normalized source list plus the normalized
  filters. `topics.region_qid` and its UNIQUE index are retired by
  migration. Every existing topic migrates to one `('region', qid)` source
  row with identity semantics unchanged.
- `/create` offers two self-serve paths: a place (today's flow, one region
  source) and a WikiProject (one wikiproject source, enwiki). The
  `wikidata` source type and multi-source composition are operator-only —
  the input UI for statement patterns is deliberately deferred.
- PageAssessments is a membership oracle only. Its quality/importance
  ratings are dropped at ingestion, no assessment-derived filter type
  exists, and curation is always the platform's own rank plus `top_n`.
- The SFBA account topic is expressible in this model: nine county region
  sources + the Q213205 region source + one wikiproject source (the SFBA
  task force) + `top_n: 500`.
- Every platform invariant holds:
  - one render per matched edit, any number of consumers
  - topic-only edits never reach account channels except via the
    account's own watchlist
  - serial, anchored Wikimedia queries — a timeout is a scope error
  - schema changes are migration files
  - rebuild refuses partial results
  - rank runs are transactional

The multi-anchor phase of the SFBA convergence plan (LUI-170, "the design
doc on converging the SFBA bots onto the platform", 2026-08-15) is
superseded by this design; its measurement, curation, and
account-cutover phases are unchanged.

## Glossary

- **QID**: A Wikidata item identifier (e.g. `Q213205`), used throughout as
  the stable name for a place, a statement's target value, or a candidate
  Wikidata-sourced item.
- **WDQS (Wikidata Query Service)**: Wikidata's public SPARQL endpoint;
  region and Wikidata-source resolution both query it.
- **SPARQL / `VALUES` batch**: The query language WDQS speaks. A `VALUES`
  clause checks membership of a batch of specific items in one query,
  which is how the deferred `in_region` filter is meant to scale rather
  than issuing one query per article.
- **Anchored query**: A query whose value side names a specific QID rather
  than leaving a property open-ended. Property-only queries are treated as
  unbounded and unsafe; every query type in this design must anchor.
- **Sitelink**: Wikidata's link from an item to its article on a specific
  Wikipedia language edition. A Wikidata-source candidate only counts
  toward a topic if it has a sitelink on a watched wiki.
- **Statement pattern**: A property+value claim shape (e.g. `P195:Q160236`)
  used to define a Wikidata source — "any item with this property set to
  this value."
- **Subclass closure**: An optional traversal of Wikidata's "subclass of"
  (`P279`) chain, so a class-based match can include subclasses rather
  than only exact matches; off by default for Wikidata sources.
- **PageAssessments**: A MediaWiki extension recording WikiProject banners
  (membership plus quality/importance ratings) on article talk pages. This
  design queries it only for membership (`list=projectpages`,
  `list=projects`) and discards the ratings.
- **WikiProject**: A Wikipedia editor-organized group that tags the
  articles it covers (e.g. "California/San Francisco Bay Area task
  force"); the new `wikiproject` source type is membership in one of these.
- **`prop=categoryinfo`**: A MediaWiki Action API call returning a
  category's member count in one request — the cheap first step in the
  WikiProject size-estimation fallback chain, before falling back to
  paging `list=projectpages`.
- **Wiki Replicas**: A read-only database mirror of Wikimedia tables
  (including, possibly, `page_assessments`) available to Toolforge tools;
  a possible faster path for WikiProject size counts if those tables live
  there.
- **Bastion**: The Toolforge SSH gateway host used to run one-off checks
  against production infrastructure, such as the Wiki Replicas
  availability check this design flags as unverified.
- **nock**: The HTTP-mocking library the test suite uses to fake Wikimedia
  API responses (pagination, renamed-project, etc.) without live calls.
- **Set-diff rebuild**: The existing nightly process that recomputes a
  topic's membership and writes only the rows that were added or removed,
  rather than replacing the whole membership set.
- **Resolver registry**: The extension point this design formalizes —
  a lookup from `source_type` to the module that knows how to turn that
  source into an article set, replacing the single hardcoded resolver
  `lib/rebuild.js` currently takes.
- **Membership oracle**: A source consulted only to answer "is this
  article in the set", with no other data taken from it — how this design
  treats PageAssessments (ratings are explicitly excluded).
- **Scope error**: A failure, such as a WDQS timeout, that is treated as
  out of scope for the current resolve and is not retried — distinct from
  a transient error worth retrying.
- **Fan-out / `resolveConsumers`**: The existing step where one matched
  edit is routed to every subscriber that should receive it (account
  channels, topics), each gated by its own membership test — referenced
  here as one of the things this design leaves untouched.
- **RAM watch index**: The in-memory `(wiki, title) → topic-id` map
  (`lib/topic-index.js`) that lets incoming edits be matched with two hash
  lookups instead of a database query; cited as the reason a giant topic
  is a memory/time cost rather than a correctness risk.
- **SFBA**: San Francisco Bay Area — the account and task force this
  design's worked example (nine county sources + one region + one
  WikiProject source) is drawn from.
- **Editorial-inlinks / rank job**: The existing per-dump job that scores
  articles by inbound editorial links; referenced as the ranking source
  the `top_n` filter reads from.

## Architecture

### The model

```
membership(topic) = filter( ∪ resolve(source) for source in topic.sources )
```

Union semantics live in the source list; intersection semantics live in
filters, which are per-article predicates. There are no expression trees.

### Source types

Three initial types, ordered by generality. The type set is an extensible
registry, not an enum baked into the schema.

| Type | `source_ref` | Resolved by |
|---|---|---|
| `region` | a Wikidata QID (`Q213205`) | `lib/region.js` — the existing curated composite: IS_HERE properties, admin-subclass walk, geo fallback. Unchanged internals. |
| `wikidata` | one anchored statement pattern, `P195:Q160236`, optional subclass-closure flag | new thin module over the WDQS plumbing extracted from `lib/region.js`. Membership = items with the statement and a sitelink on a watched wiki. |
| `wikiproject` | wiki + project name, `en:California/San Francisco Bay Area task force` | new module over PageAssessments `list=projectpages` via `lib/mw-api.js`. Ratings dropped at ingestion. |

`region` is not re-expressible as a `wikidata` row: it bundles several
statement patterns plus boundary and person-inclusion rules. Keeping it a
distinct type is deliberate.

Two guardrails carry over from the region work: the value side of every
query is always anchored to a specific QID (property-only queries are
unbounded), and a WDQS timeout is a scope error, never a retry. Raw SPARQL
as a source type is rejected: it cannot be canonically hashed for
identity and cannot be safely estimated.

### Schema

```sql
-- new
CREATE TABLE topic_sources (
  topic_id     BIGINT NOT NULL,          -- FK topics.id
  source_type  VARCHAR(32) NOT NULL,     -- 'region' | 'wikidata' | 'wikiproject'
  source_ref   VARCHAR(255) NOT NULL,    -- normalized per type
  PRIMARY KEY (topic_id, source_type, source_ref)
);

-- changed
--   topics.region_qid dropped; UNIQUE (region_qid, filters_hash) dropped
--   topics.identity_hash CHAR(64) NOT NULL, UNIQUE
--   identity_hash = sha256(sorted normalized sources ‖ normalized filters)
```

`topic_articles` is unchanged; its existing `source` column records which
source row produced each membership row. The data migration writes one
`('region', qid)` row per existing topic and computes its identity hash.

### Resolver registry

`lib/rebuild.js` already accepts a pluggable resolver (line 52); this
design makes the plug-point a registry keyed by `source_type`. Every
resolver module exposes the same contract:

```
resolve(source_ref, {languages}) → {articles: [{wiki, title, qid?}], partial: bool}
estimate(source_ref)             → {count, warnings}
```

Rebuild, per topic: resolve each source serially → refuse the whole
rebuild if any source is partial → union with dedup on (wiki, title) →
apply filters → existing set-diff write to `topic_articles`. An empty
result from a `wikiproject` or `wikidata` source counts as partial. A
renamed project or an API failure is far likelier than a genuinely empty
set, and a silent empty resolve would evaporate a topic's membership.

Freshness: PageAssessments lags talk-page banner changes by roughly a day
and has no membership event feed, so the nightly rebuild is the natural
refresh cadence for all source types.

### Filters

Per-article predicates applied to the union at rebuild time:

- `languages` (exists) — sitelink requirement for `region`/`wikidata`;
  inherent for `wikiproject` (a project lives on one wiki).
- `top_n` (SFBA plan phase 2, unchanged) — membership limited to
  `rank <= top_n`; ranks computed by the per-dump editorial-inlinks job
  over the uncut union; unranked new members excluded until ranked.
- `entity` (exists as stored-but-unapplied `entity_filters`) — becomes
  enforced: restrict to instances of given classes.
- `in_region` (designed now, built later) — the intersection predicate:
  member's QID must fall inside a region per `memberPattern`, evaluated
  as chunked WDQS `VALUES` batches. Articles without a QID fail the
  predicate by definition; that is stated behavior.
- No assessment-class filter, ever.

The filters hash covers the normalized filter set exactly as today;
adding or removing any filter makes a different topic.

### Creation surfaces

`/create` gains a second path. "A place" is today's flow, unchanged, now
writing one `('region', qid)` source row. "A WikiProject" is a name field
validated against PageAssessments `list=projects` (which doubles as
autocomplete data), producing one `('wikiproject', ref)` source row;
enwiki only at first. Both existing gates stay load-bearing:
`topic_store` + invite codes, and `max_articles` — which becomes the
platform's scale gate for every source type, catching "politicians,
globally" at creation time.

WikiProject estimation is a fallback chain, not a paging walk:
`prop=categoryinfo` on the project's banner category
(`Category:WikiProject <name> articles`) returns an exact count in one
request; when the category is missing or nonstandard, fall back to paging
`list=projectpages` that stops as soon as the count exceeds
`max_articles`. Pre-implementation check: whether the `page_assessments`
tables are on Wiki Replicas (one `SHOW TABLES` from the bastion —
unverified as of 2026-08-16). If they are, a replica `COUNT(*)` becomes
the primary path in production, since the webservice already carries
`TOOL_REPLICA_*` credentials.

Everything richer — `wikidata` sources, multi-source composition — goes
through an operator CLI that validates each source ref, runs
`estimate()` per source, applies `max_articles` to the union estimate,
and upserts. No admin web UI in scope.

### What does not change

Everything downstream of `topic_articles` is already membership-source
agnostic and is untouched: the RAM watch index (`lib/topic-index.js`),
edit fan-out and `resolveConsumers` with its incident-regression tests
(`page-watch.js`, `test/fan-out.test.js`), delivery
(`lib/subscription-delivery.js`), title resolution
(`lib/title-resolver.js`), and every delivery-side guard (URL allowlist,
rate caps, quarantine).

## Existing Patterns

Codebase investigation (2026-08-15, on `integration`) found:

- The downstream pipeline operates on bare (wiki, title) sets with zero
  region awareness; the place assumption is concentrated in topic
  identity (`db/migrations/001-initial-schema.sql` UNIQUE
  `(region_qid, filters_hash)`), the creation flow
  (`lib/topic-create.js`, `public/server.js`), and `lib/region.js`.
- `lib/rebuild.js:52` already takes a pluggable resolver; this design
  formalizes the seam rather than inventing one.
- `topic_articles.source` already distinguishes membership sources.
- `lib/watchlist-sync.js` already fetches the account watchlist via
  PageAssessments `list=projectpages` — the production watchlist is a
  wikiproject query running outside the topic system. This design is the
  reconciliation of that duality, not the introduction of a new source.
- Filter normalization and hashing (`lib/topic-store.js:37–64`) already
  hash a normalized filter object; the identity hash extends the same
  approach to sources.

Divergence: `strategy` ('auto'|'admin'|'geo') stops being a topic-level
concept and becomes internal to the `region` resolver, where it always
belonged.

## Implementation Phases

### Phase 1: Sources-table migration and identity hash
**Goal:** Topic identity = sources + filters; region_qid retired.

**Components:**
- New migration in `db/migrations/` — `topic_sources` table,
  `topics.identity_hash`, drop `region_qid` + its UNIQUE index, data
  migration for existing topics
- `lib/topic-store.js` — `upsertTopic` takes a source list + filters;
  identity hashing; `topicsForRegion` replaced by source-aware lookups

**Dependencies:** none. Must land before the SFBA plan's multi-anchor
phase, which it supersedes.

**Done when:** migration round-trips on the throwaway DB; identity-hash
property tests pass (source order irrelevant, filter normalization,
region-only topics keep deduping as before); full suite green.

### Phase 2: Resolver registry and union rebuild
**Goal:** Rebuild resolves N sources per topic and unions them.

**Components:**
- `lib/rebuild.js` — registry keyed by `source_type`; per-source serial
  resolve; per-source partial refusal; union dedup on (wiki, title)
- `lib/region.js` wrapped as the `region` resolver (internals unchanged;
  `strategy` moves inside)

**Dependencies:** Phase 1.

**Done when:** a multi-source topic (two region sources) rebuilds to the
deduped union; a partial source refuses the whole rebuild; existing
single-region topics rebuild identically to before; tests pass.

### Phase 3: WikiProject resolver and estimator
**Goal:** `wikiproject` topics resolve and can be sized cheaply.

**Components:**
- New `lib/wikiproject-source.js` — `list=projectpages` enumeration via
  `lib/mw-api.js` (serial, paginated, ratings dropped, empty = partial);
  `estimate()` as the categoryinfo → bounded-paging fallback chain

**Dependencies:** Phase 2. Pre-check: Wiki Replicas `page_assessments`
availability (one bastion command) to pick the production-primary count
path.

**Done when:** resolver-contract tests pass on nock fixtures including
pagination, a renamed project (empty → partial), and the estimator's
early stop under a fake 2M-row project.

### Phase 4: Wikidata statement resolver
**Goal:** `wikidata` topics (operator-only) resolve.

**Components:**
- New `lib/wikidata-source.js` — parses `P###:Q###` (+ optional closure
  flag), one anchored WDQS query per watched language via the SPARQL
  plumbing shared with `lib/region.js`, sitelink required

**Dependencies:** Phase 2.

**Done when:** contract tests pass (valid/invalid refs, anchoring
enforced, closure flag off by default, timeout classed as scope error);
a live spot-check of one small ref (e.g. a museum collection) matches
expectations.

### Phase 5: Operator creation CLI
**Goal:** Multi-source and `wikidata` topics can be created, gated.

**Components:**
- New `scripts/topic-admin.js` — takes a topic definition (source rows +
  filters), validates every ref per type, runs `estimate()` per source,
  applies `max_articles` to the union estimate, upserts via
  `lib/topic-store.js`

**Dependencies:** Phases 3–4.

**Done when:** the SFBA definition (10 region + 1 wikiproject +
`top_n: 500`) validates and upserts on a local DB; an over-gate
definition is refused with the union estimate in the error.

### Phase 6: /create WikiProject path
**Goal:** Self-serve wikiproject topics.

**Components:**
- `public/server.js` — project-name search endpoint backed by
  `list=projects`; create path writing one wikiproject source row;
  estimator wired to the Phase 3 chain
- `lib/topic-create.js` — source-type branch; existing gates unchanged

**Dependencies:** Phase 3.

**Done when:** form-level tests cover both paths; the wikiproject path
refuses an over-`max_articles` project using at most the bounded page
budget, and the place path behaves identically to before.

### Phase 7: Entity filter enforcement
**Goal:** The stored-but-unapplied `entity_filters` becomes real.

**Components:**
- `lib/rebuild.js` — entity predicate applied in the filter pass,
  anchored class checks batched per Wikimedia etiquette

**Dependencies:** Phase 2.

**Done when:** a topic with an entity filter rebuilds to the restricted
set; filter participates in identity exactly as today (it already
hashes); tests pass.

## Additional Considerations

**Relationship to the SFBA convergence plan** (LUI-170, design doc dated
2026-08-15): its phase 0 (measure) and phases 2–3 (curation, account
cutover) proceed unchanged on top of this design. Its phase 1
(`topic_regions`, anchors joining the dedup hash) is superseded by
Phases 1–2 here and must not ship. Its "multi-anchor topics come from
the admin console" becomes Phase 5's CLI.

**Deferred, deliberately:** the `in_region` intersection filter
(designed above; implementation is chunked `VALUES` batches and carries
rebuild-time cost against big wikiprojects); any admin web UI; the
`wikidata` input UX on `/create`; non-enwiki wikiprojects (PageAssessments
coverage varies by wiki).

**Error surface:** a wikiproject source whose project disappears from
`list=projects` fails resolve as partial, so the topic keeps its last
good membership and the rebuild log names the source — the same behavior
operators already get from partial region resolves.

**Scale:** WikiProject Biography is ~2.06M articles (banner category
count, read 2026-08-16). The RAM watch index holds (wiki, title) →
topic-id maps, so a deliberately created giant topic is a memory and
rebuild-time cost, not a correctness risk; `max_articles` is the
intended guard and applies to every source type.
