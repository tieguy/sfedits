# Place-Bot Platform Design

## Summary

Today the fork runs one bot: a hardcoded (and, more recently, WikiProject-derived)
watchlist of San Francisco Bay Area articles, one set of delivery credentials, one
`config.json`. This design generalizes it into a self-serve platform where any
qualifying Wikipedian can create a bot that watches Wikipedia edits to articles
about a **place** — any neighborhood, city, county, or state — and posts them to
Discord, Bluesky, or Mastodon.

The approach is deliberately not a rewrite. The per-edit hot path stays what it
is today: an in-RAM title lookup against a prebuilt index, feeding the existing
diff renderer and platform adapters. What changes is *where the index comes from*
and *who it is delivered to*. A **region resolver** turns a Wikidata QID into a
set of article QIDs (two query strategies, chosen by region scale); a **topic
store** on Toolforge's MariaDB deduplicates identical feeds across users and
attaches per-user delivery subscriptions to them; a **rebuild job** refreshes
those sets nightly and resolves QIDs to current titles; and a **web flow** with
Wikimedia OAuth lets people create and discover bots. The existing SFBA bot
becomes the first row in the topic table rather than a special case.

## Definition of Done

A Wikipedian other than the maintainer can, unaided:

1. Visit the tool's web page and log in with their Wikimedia account (gated on
   edit count, account age, and not-currently-blocked).
2. Type a place name, pick the right one from autocomplete disambiguated by
   description and mini-map, and see an estimated article count and posts/day
   that updates in real time as they toggle entity-type and language filters.
3. See existing public bots for that place first, and follow one in a single
   click rather than creating a duplicate.
4. If none matches, submit a custom bot, watch it build asynchronously, and view
   a dry-run preview ("the last 10 edits this would have posted") before it goes
   live.
5. Receive posts to a Discord webhook they supplied, or to their own Bluesky /
   Mastodon account via bring-your-own credentials.

And operationally:

6. Two people choosing the same place and filters share **one** topic, one
   rebuild, and one diff render per edit — with separate delivery.
7. Lists rebuild on a schedule; page renames do not silently drop articles;
   newly created articles about the place are detected as a signal.
8. Region size caps, per-subscription post-rate caps, bot-edit skipping, and
   automated-account labeling are enforced.
9. The whole thing runs on Toolforge: continuous job for the edit stream,
   scheduled job for rebuilds, webservice for the web app, ToolsDB for storage.
10. The existing SFBA bot runs on this machinery with no loss of current
    behavior (rich Discord embeds, revdel sweeping, Wikidata claim watch).

## Glossary

- **QID**: A Wikidata entity identifier (`Q62` = San Francisco). Unambiguous
  where names are not — "Richmond" is both an SF district and an East Bay city.
  Every place and article in this design is identified by QID, never by name.
- **WDQS / SPARQL**: The Wikidata Query Service and its query language. Used at
  build time to enumerate what is "in" a place. Has a 60-second timeout, which is
  the dominant constraint on large regions.
- **P131 (`located in the administrative territorial entity`)**: A transitive
  Wikidata property. `?x wdt:P131* wd:Q62` returns everything administratively
  inside San Francisco, recursively.
- **P402**: Wikidata property linking an entity to its OpenStreetMap relation —
  the source of a boundary polygon for spatial queries.
- **P31 (`instance of`)**: Used to classify a region as an administrative entity
  vs. an informal neighborhood, which selects the membership strategy.
- **Topic**: A deduplicated feed definition — one region QID plus a normalized
  set of filters. Two users who want the same thing share one topic.
- **Subscription**: One user's personal delivery attachment to a topic (their
  Discord webhook, their Mastodon account, their display name).
- **Toolforge**: Wikimedia's hosted platform for community tools. Provides
  ToolsDB, Wiki Replicas, Wikimedia OAuth, continuous jobs, scheduled jobs, and
  webservices.
- **ToolsDB**: Toolforge's shared MariaDB instance. The store of record here.
  SQLite on Toolforge's NFS-backed home storage is the known-bad alternative.
- **Wiki Replicas**: Read-only MariaDB replicas of every Wikimedia wiki,
  auto-credentialed on Toolforge. Used at rebuild time for QID↔title joins
  (`page_props`) and page-move detection (`logging`) without API rate limits.
- **PageAssessments**: The MediaWiki extension backing the current dynamic
  watchlist — WikiProject/task-force membership declared by talk-page banners.
  A third membership source alongside geo and admin containment.
- **EventStreams**: Wikimedia's SSE feed of live edits. Replaced IRC in this
  fork; the source of the per-edit hot path.
- **satori / resvg**: The native (Chromium-free) rendering stack this fork uses
  to turn diffs into PNGs.
- **Point-in-polygon**: The spatial filter step — testing candidate coordinates
  against a boundary polygon.

## Architecture

Five components, three of them new.

**Region resolver** (`lib/region.js`, new). Takes a place QID and returns a set
of article QIDs plus a class×language histogram. Dispatches between two
membership strategies, because scale — not preference — dictates the query:

- *Administrative containment* for real admin entities (city, county, state):
  one transitive `P131*` closure. Coordinate-free, catches items with no precise
  point, and does not scan millions of coordinates.
- *Geographic containment* for informal regions (neighborhoods that are not
  administrative entities): resolve `P402` → OSM boundary polygon, seed
  candidates with a Wikidata radius query around the centroid, point-in-polygon
  filter. Only viable because the candidate set is small.

`strategy: "auto"` resolves `P31` to pick; always overridable. Large closures are
chunked (per sub-entity or per class) and cached — the fork already learned this
the hard way in `lib/wikidata-claim-watch.js`, where a nine-county union times
out but per-county anchored queries do not.

**Topic store** (`lib/topic-store.js`, new; ToolsDB). Store of record, plus an
in-RAM index the bot loads at startup and reloads on a generation bump. Schema:

```sql
topics(id, region_qid, filters_hash, entity_filters JSON, languages JSON,
       strategy, generation, created_at)
  UNIQUE(region_qid, filters_hash)

articles(id, wikipedia, title, wikidata_qid)
  UNIQUE(wikipedia, wikidata_qid)

topic_articles(topic_id, article_id, source, score, added_at, removed_at)

subscriptions(id, topic_id, owner_user, delivery_type, delivery_config JSON,
              display_name, status, created_at)
```

`filters_hash` is a hash of *normalized* inputs — QID, sorted entity filters,
sorted languages — so "Mission+places+en" and "Mission+en+places" collide into
one topic. `source`/`score` carry provenance, so geo, admin, and PageAssessments
membership can be tuned and diffed separately. A topic lives while ≥1
subscription references it and is GC'd when the last one leaves, which decouples
topic lifetime from any one owner: if the original creator deletes their
subscription, everyone else's bot keeps working.

The exported contract the bot depends on:

```js
// lib/topic-store.js
getWatchIndex()   // → Map<wikipedia, Map<title, topicId[]>>, plus a generation
refreshTopic(topicId, { force })  // rebuild one topic's article set
topicsForRegion(regionQid)        // discovery
subscriptionsForTopic(topicId)    // fan-out
```

**Rebuild job** (`scripts/rebuild-topics.js`, new; scheduled). For each topic:
run the resolver, set-diff the QID set against the stored prior set, resolve QIDs
to current titles, detect renames. Two payoffs fall out for free — any QID
appearing for the first time *is* the "new article about this place" signal, and
rename detection is what keeps a title-keyed hot path from silently going dead.
Title resolution uses Wiki Replicas (`page_props` join for page↔QID, `logging`
for moves) rather than the API: batch-time, no rate limits, seconds-to-minutes
of replica lag which is irrelevant for a nightly pass.

**Matcher and fan-out** (`page-watch.js`, `lib/watchlist-sync.js`, modified).
The hot path stays an O(1) in-RAM hash hit. What changes is its shape:
`isWatched(account, edit) → boolean` becomes `topicsForEdit(edit) → topicId[]`,
and one edit fans out to topics, then to each topic's subscriptions. The diff is
rendered **once per edit** and reused across every subscription — this is the
whole operational point of deduplicating on topic. 500 Mission bots means 1
topic, 1 build, 1 render, 500 subscription rows.

**Delivery adapters** (`lib/discord-platform.js`, `lib/bluesky-platform.js`,
`lib/mastodon-platform.js`, modified). Today each reads credentials from the
account config. Each grows a per-subscription variant that takes a rendered post
plus a `delivery_config`. Discord webhooks ship first because they need no OAuth
plumbing — just a POST to a URL the user pastes in.

**Web app** (`admin/`, extended). A CRUD front-end over `topics`/`subscriptions`,
discovery-first: search a place → show existing public bots → one-click follow →
fall through to the custom form only if nothing matches. Wikimedia OAuth
replaces the current email-code auth and doubles as the eligibility gate, since
it hands back global edit count and account age directly.

The live count estimate is the one non-obvious piece of the create flow. Picking
a place is one deliberate action, so a spinner is acceptable there — that runs
**one** aggregation query returning a histogram bucketed by entity class ×
language (a few hundred rows regardless of region size, not the articles
themselves). Every subsequent checkbox toggle is a client-side sum over
histogram cells: sub-millisecond, zero I/O, genuinely real-time. It is an
estimate by design — big regions may time out and show "~80,000+", and
post-filters trim the raw closure. The dry run is the source of truth. Count
**watched pages** across selected languages, not distinct places, because pages
are what drive post volume, which is what the estimate exists to warn about.

Scale, and what breaks where:

| Region | ~Articles | Failure mode |
|---|---|---|
| Neighborhood | 10²–10³ | nothing |
| City (SF) | 10³–10⁴ | config bloat (solved by the DB) |
| County | ~10⁴ | SPARQL 60s timeout (solved by chunking) |
| State (CA) | 10⁵+ | timeout **and** unusable post volume (solved by the cap) |

## Existing Patterns

Investigation of the `integration` branch found that a meaningful fraction of
this design already exists in single-purpose form. **The source design doc
(`docs/design-place-bot-platform.md`, PR #1) was written against upstream `main`
and is stale in several places.** Corrections, and what each implies:

| Source doc assumption | `integration` reality | Implication |
|---|---|---|
| IRC feed via `wikichanges` | EventStreams (`lib/edit-stream.js`) | No feed work needed |
| Screenshots via Puppeteer; Toolforge needs Chromium in the image | Native satori/resvg (`lib/diff-render-native.js`) | The Toolforge screenshot-feasibility section is moot; drop it |
| "Add a Discord webhook delivery adapter" | `lib/discord-platform.js` exists with rich embeds | Generalize to per-subscription, don't build |
| Static watchlist in config | `lib/watchlist-sync.js`: dynamic fetch, disk cache, outage fallback, periodic refresh, `isWatched()` | The refresh/cache/fallback pattern is proven — the topic store follows it, swapping PageAssessments for the region resolver |
| `P131*` transitive closure is new work | `lib/wikidata-claim-watch.js` runs per-county `P131+` closures, ~12k QIDs, cached to disk | The admin strategy is a generalization of working code, including the chunking workaround for WDQS timeouts |
| PII screening applies to every bot | Fork sets `pii_blocking.enabled: false`, relying on `lib/revdel-check.js` instead | Safety phase must re-decide this for third-party bots, not assume the gate exists |

Patterns this design follows from existing code:

- **Store-of-record + in-RAM index with disk/DB fallback.** `watchlist-sync.js`
  caches its fetched list to `data/watchlist-<project>.json` so a restart during
  an API outage falls back to the last good list rather than an empty watchlist.
  The topic store keeps this property with ToolsDB in the cache's role.
- **Chunk expensive SPARQL, anchor the transitive path.** From
  `wikidata-claim-watch.js`: a union across nine counties times out; one query
  per county does not. The region resolver generalizes this to sub-entity and
  class chunking.
- **Periodic refresh with configurable `refresh_hours`**, timers started at boot
  (`startWatchlistSync`, `startClaimWatch`). The rebuild job follows this shape
  but moves to a Toolforge scheduled job, since a nightly full rebuild is too
  heavy for an in-process timer.
- **Express app with route-level auth middleware** (`admin/server.js`,
  `requireAuth`). The create/discovery flow extends this app rather than standing
  up a second service.
- **Config-stanza-per-feature** (`watchlist_source`, `wikidata_claims`,
  `pii_blocking`). Platform config gets the same treatment.

Divergences, with justification:

- **Storage moves from JSON files under `data/` to ToolsDB.** Justified by
  multi-tenancy: `topic_articles` is an M:N relation queried by both the bot and
  the web app, and per-user subscription rows need transactional integrity that
  file writes do not provide. Single-tenant JSON caching stays for the in-RAM
  index warm-start.
- **`isWatched() → boolean` becomes `topicsForEdit() → topicId[]`.** The current
  signature assumes one account with one list; fan-out requires knowing *which*
  topics matched.

## Implementation Phases

Nine phases. See Additional Considerations for the required split into two
implementation plans.

### Phase 1: Region resolver

**Goal:** Turn a place QID into an article-QID set and a count histogram, at
every region scale, without hitting WDQS timeouts.

**Components:**
- `lib/region.js` — `resolveRegion(qid)` returning `{qid, type, strategy,
  polygon?, centroid?}` from `P31`/`P402`; `articlesForRegion(region, filters)`
  dispatching admin (`P131*`, chunked per sub-entity/class) vs. geo (radius seed
  + point-in-polygon); `regionHistogram(region)` returning class×language counts.
- SPARQL execution and retry/chunking helpers, extracted from the working
  implementation in `lib/wikidata-claim-watch.js` so both callers share one path.
- `test/region.test.js` — nock-backed WDQS fixtures for an admin region (SF), an
  informal neighborhood (Mission), and a timeout forcing the chunked path.

**Dependencies:** None.

**Done when:** Given `Q62` the resolver returns a plausible SF article set;
given the Mission's QID it returns a polygon-filtered set; a simulated WDQS
timeout produces chunked queries and a complete result; the histogram row count
is bounded regardless of region size. Tests pass.

### Phase 2: Topic store on ToolsDB

**Goal:** Durable, queryable topic/subscription storage with an in-RAM index.

**Components:**
- `lib/topic-store.js` — connection handling, the four tables above, and the
  exported contract (`getWatchIndex`, `refreshTopic`, `topicsForRegion`,
  `subscriptionsForTopic`), plus `filters_hash` normalization.
- `db/migrations/` — schema migrations, runnable against ToolsDB and against a
  local MariaDB for development.
- `test/topic-store.test.js` — against a local MariaDB; covers hash
  normalization collision (filter order must not create a second topic), M:N
  membership, and topic GC when the last subscription is removed.

**Dependencies:** Phase 1 (the resolver output is what gets stored).

**Done when:** Migrations apply cleanly; two differently-ordered filter sets for
the same region resolve to one topic row; `getWatchIndex()` returns a populated
`Map<wikipedia, Map<title, topicId[]>>`; removing the last subscription GCs the
topic. Tests pass.

### Phase 3: Rebuild job and title resolution

**Goal:** Keep topic article sets and their title index fresh, and surface new
articles.

**Components:**
- `lib/title-resolver.js` — QID↔title via Wiki Replicas (`page_props` where
  `pp_propname='wikibase_item'`), page-move detection via `logging`, with a
  Wikidata/MediaWiki API fallback for non-Toolforge development.
- `scripts/rebuild-topics.js` — per-topic rebuild: resolve, set-diff against the
  stored QID set, write `added_at`/`removed_at`, bump `generation`, emit
  new-article events.
- `test/rebuild-topics.test.js` — set-diff produces correct add/remove sets; a
  renamed page updates its title without losing membership; a new QID is
  reported as a new-article signal.

**Dependencies:** Phases 1, 2.

**Done when:** A rebuild against a seeded topic correctly adds, removes, and
renames; generation bumps; new-article events emit. Tests pass.

### Phase 4: Bot wiring and fan-out

**Goal:** The running bot matches against the topic store and fans one edit out
to many subscriptions, rendering the diff once.

**Components:**
- `lib/watchlist-sync.js` — `topicsForEdit(edit) → topicId[]` alongside the
  existing `isWatched()`, backed by the topic store's index; generation-bump
  reload without restart.
- `page-watch.js` — `inspect()` fans edit → topics → subscriptions; the diff
  render happens once per edit and its result is passed to each delivery.
- Config: a `topic_store` stanza, following the existing per-feature pattern.
- `test/fan-out.test.js` — one edit matching two topics with three total
  subscriptions triggers exactly one render and three deliveries; a generation
  bump swaps the index live.

**Dependencies:** Phases 2, 3.

**Done when:** A single simulated edit produces one render and N deliveries;
index reload on generation bump works without dropping edits; the existing SFBA
account still posts unchanged. Full suite passes.

### Phase 5: Per-subscription Discord delivery

**Goal:** Deliver to a webhook supplied by a third party, safely.

**Components:**
- `lib/discord-platform.js` — a per-subscription entry point taking a rendered
  post plus `delivery_config`, preserving the existing rich-embed formatting
  (including the parens-escaping fix).
- `lib/delivery-limits.js` — per-subscription posts/hour cap with a "your list
  is too big" notice, following the rate-cap pattern already in
  `lib/wikidata-claim-watch.js`.
- Webhook validation and failure handling: repeated 4xx marks a subscription
  `status = 'broken'` rather than retrying forever.
- Tests for cap enforcement, notice emission, and broken-subscription marking.

**Dependencies:** Phase 4.

**Done when:** Two subscriptions on one topic deliver to two different webhooks
from one render; the cap suppresses excess posts and emits one summary notice; a
dead webhook marks the subscription broken. Tests pass.

### Phase 6: Wikimedia OAuth

**Goal:** Real Wikimedian identity, and the eligibility gate that rides on it.

**Components:**
- `admin/auth-mwoauth.js` — OAuth handshake, session issuance, replacing the
  email-code flow in `admin/server.js` while keeping `requireAuth`'s shape.
- Eligibility check on global edit count, account age, and block status, with
  thresholds in config.
- `users` table (or columns on `subscriptions`) tying `owner_user` to a
  Wikimedia identity.
- Tests: eligible user gets a session; under-threshold and blocked users are
  rejected with distinguishable errors.

**Dependencies:** Phase 2.

**Done when:** OAuth login works against Wikimedia's staging consumer; existing
admin routes authenticate through the new session; ineligible accounts are
refused. Tests pass.

### Phase 7: Create and discovery web flow

**Goal:** A non-maintainer can find or create a bot end to end.

**Components:**
- Discovery: place search → existing public topics for that region → one-click
  follow (creates a subscription on an existing topic).
- Create form: place autocomplete with description and mini-map, entity-type
  checkboxes, language checkboxes pre-filled from the place's sitelinks,
  delivery target.
- Live count: one histogram fetch on place selection, client-side recompute on
  every toggle; volume warning when over the cap.
- Async build: submit → queued job → "building…" → ready, with a dry-run preview
  of the last 10 edits the bot would have posted, read from recentchanges.
- "My bots" list: view, pause, delete.
- Tests for the count recompute logic, dry-run assembly, and the
  follow-existing-topic path (must not create a second topic).

**Dependencies:** Phases 1, 2, 5, 6.

**Done when:** A test user completes discovery→follow and create→dry-run→live
without maintainer intervention; toggling filters updates the count with no
network request; two users creating the same bot produce one topic and two
subscriptions.

### Phase 8: Bring-your-own-auth Bluesky and Mastodon delivery

**Goal:** Delivery to the creator's own accounts, not just a webhook.

**Components:**
- `lib/bluesky-platform.js`, `lib/mastodon-platform.js` — per-subscription
  entry points mirroring Phase 5's Discord shape.
- Credential capture in the create flow and encrypted-at-rest storage in
  `delivery_config`.
- Credential-failure handling reusing Phase 5's broken-subscription path.
- Tests for both adapters against nock fixtures, plus credential-rejection
  handling.

**Dependencies:** Phases 5, 7.

**Done when:** A subscription posts to a Bluesky account and a Mastodon account
using creator-supplied credentials; revoked credentials mark the subscription
broken rather than crashing the fan-out. Tests pass.

### Phase 9: Safety, limits, and launch gate

**Goal:** The guardrails that must exist before third parties can create bots.

**Components:**
- Region size floor and ceiling, measured as estimated article count from the
  Phase 1 histogram — enforced at creation and re-checked at rebuild.
- Bot-flagged edit skipping in the fan-out path.
- Auto-naming from the place (with a filter suffix when two topics share a place
  but differ by filters), sidestepping naming and squatting disputes.
- Automated-account labeling: platform bot flags set, posts labeled as automated.
- A decision, recorded here, on whether third-party bots re-enable the PII gate
  (`pii_blocking`) or rely on the revdel sweeper as the fork's own bot does.
- Tests for cap enforcement at both creation and rebuild, bot-edit skipping, and
  name collision suffixing.

**Dependencies:** Phases 5, 7.

**Done when:** A too-large region is refused at creation with the estimate shown;
a region that grows past the cap is flagged at rebuild; bot-flagged edits produce
no posts; two same-place different-filter topics get distinct auto-names; all
posts carry automated labeling. Full suite passes.

## Additional Considerations

**Implementation scoping.** This design has nine phases; the writing-plans skill
caps an implementation plan at eight. Split at the 5/6 boundary:

- **Plan A — backend (Phases 1–5).** Ends with a deployable bot whose watchlist
  comes from the topic store and which fans out to multiple Discord webhooks.
  Useful on its own: the SFBA bot migrates onto it, and additional bots can be
  created by inserting rows.
- **Plan B — platform surface (Phases 6–9).** OAuth, web flow, BYO-auth
  delivery, guardrails. Nothing here is safe to expose without Plan A landed.

The split is also the natural go/no-go: if Plan A proves the region resolver
does not hold up at county scale, Plan B is not worth writing.

**Migrating the existing bot.** Phase 4 must keep the SFBA account working
throughout — rich Discord embeds, revdel sweeping, and the Wikidata claim watch
are fork features with no upstream equivalent, and they are the regression test
for whether generalization broke anything. Treat the SFBA config as a fixture,
not as something to delete once topics exist.

**PageAssessments as a third membership source.** The current bot's list comes
from a WikiProject task force, not from geography. `topic_articles.source`
accommodates this, but no phase above builds it — task-force membership is
neither geo nor admin containment. Worth adding once the two primary strategies
are proven; noted here so the schema is not narrowed in Phase 2.

**Deferred, and why.**
- *Credential death.* Bring-your-own tokens expire or get revoked and the bot
  goes quiet with no signal. Phase 8 marks the subscription broken; notifying the
  creator is deferred. The likely answer is a low-frequency notice to their user
  talk page — we have their identity from OAuth — but a bot editing talk pages is
  itself subject to bot-editing norms and needs its own thinking.
- *Rebuild cadence.* Nightly is the likely sweet spot. The real bound is what
  fits in a Toolforge job slot, which the Phase 9 size cap self-limits.
- *Notability defaults* (minimum sitelinks or pageviews). Ship fixed sane
  defaults; do not expose knobs until someone asks.
- *Private bots.* Public by default for MVP. Add private only if a concrete need
  appears — it interacts badly with topic sharing.

**Surveillance floor.** The minimum region size is not only about usefulness. It
prevents a "place" from collapsing to a single person's article. All editor
contributions are already public, so the residual concern is amplification rather
than exposure — but amplification is exactly what this platform multiplies, and
the floor is the cheapest control for it.
