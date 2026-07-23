# Design: Place-Bot Platform

*Status: design draft. Nothing here is built yet. Captures the design conversation
so it can be picked up in a later session.*

## Goal

Generalize the current single-purpose bot (a hardcoded watchlist of SF political
figures) into a **self-serve platform** where a qualifying Wikipedian can create a
bot that watches Wikipedia edits to articles about a **place** — any neighborhood,
city, county, or state — and posts them to Bluesky / Mastodon / Discord.

The motivating instance is a Mission-District-only bot, but the design is
parameterized by an arbitrary political/geographic boundary.

## Core insight: the runtime barely changes

The entire match mechanism today is one check in `page-watch.js` (`inspect()`):

```js
if (account.watchlist && account.watchlist[edit.wikipedia]
  && account.watchlist[edit.wikipedia][edit.page]) { ... }
```

The watchlist is a nested dict of **exact Wikipedia page titles**. Everything else
— IRC feed, PII screening, screenshots, Bluesky/Mastodon posting — is agnostic to
*how* that list was built. So the bulk of this project is **list generation and a
management layer**, not a rewrite of the bot. The per-edit lookup stays an O(1)
in-memory hash hit even at 10^5 titles.

`getConfig()` already supports loading part of the config from an external file
(`account.ranges` can be a path string). The same trick lets `watchlist` be a
generated file / DB-backed index instead of an inline literal.

## What already exists and is reused as-is

This is **not** a greenfield build. The repo already ships the hard parts:

- Real-time feed listener (`wikichanges`)
- Match logic (`inspect()`)
- **Screenshot pipeline** (`lib/screenshot.js`) — hardened, not a prototype
- Dual-platform posting (`lib/bluesky-platform.js`, `lib/mastodon-platform.js`)
- PII screening (Python/Presidio service + Gemini fallback)
- An Express admin/draft web app (starting point for the create/manage UI)

The generalization is mostly re-wiring this core:

1. **Swap** the static watchlist for a region-resolver + topic store (the one
   genuinely new backend piece).
2. **Add** a create/discovery web flow + Wikimedia OAuth.
3. **Add** a Discord-webhook delivery adapter alongside the two platform modules.
4. **Port** storage to Toolforge's hosted MariaDB (ToolsDB).

## Building the article list from a place

### Anchor on a Wikidata QID, never a name

Names collide (Richmond the SF district vs. the East Bay city; Georgia the state
vs. the country). A QID is unambiguous and unlocks both the boundary (`P402` → OSM
relation) and administrative containment (`P131`). The create flow resolves a
typed place name to a QID via autocomplete and stores the QID.

### Two membership strategies, chosen by region type

Scale — not preference — dictates which query you use. There is no single query
that works from "Balmy Alley" to "California".

- **Geographic containment (spatial)** — for informal regions (neighborhoods that
  are not administrative entities). Get the OSM boundary polygon, seed candidates
  with a Wikidata radius query around the centroid, then point-in-polygon filter.
  Works because the candidate set is small.

- **Administrative containment (relational)** — for real admin entities
  (city/county/state). Wikidata `P131` is transitive, so one query returns the
  whole hierarchy:

  ```sparql
  SELECT ?item ?article WHERE {
    ?item wdt:P131* wd:Q62 .           # everything in SF, recursively
    ?article schema:about ?item;
             schema:isPartOf <https://en.wikipedia.org/> .
  }
  ```

  Coordinate-free (catches items without precise points) and doesn't require
  scanning a polygon over millions of coordinates — the reason spatial can't be
  used for a state.

`strategy: "auto"` resolves the region's `P31` (instance-of): admin entity with
sub-entities → `admin`; informal neighborhood → `geo`. Always overridable.

### Scale is the dominant constraint

| Region | ~Articles | What breaks |
|---|---|---|
| Neighborhood | 10^2–10^3 | nothing |
| City (SF) | 10^3–10^4 | config bloat |
| County | ~10^4 | SPARQL 60s timeout |
| State (CA) | 10^5+ | timeout **+ post volume** |

Mitigations: chunk large closures (by sub-entity / class) and cache; store the
watchlist as a DB-backed index, not inline config; **enforce a max region size**
(see area caps) so a bot can't be "all of the US" (useless firehose) and the
rebuild fits in a Toolforge job slot.

## Membership identity: QID with a title-resolution layer

The list is machine-only (QIDs); it does not need to be human-readable. But the
IRC feed emits **titles**, and Wikipedia renames articles constantly — matching on
a stale title silently fails. So:

- **Identity = QID.** The topic's article set is a set of QIDs.
- **Match against a derived title index**, refreshed on the rebuild cadence.
- On **Toolforge, resolve QID ↔ title via the Wiki Replicas** (managed read-only
  MariaDB replicas of every wiki, auto-credentialed in `~/.my.cnf`). A plain SQL
  join, no API rate limits:
  - `page_props` where `pp_propname='wikibase_item'` → page ↔ QID (stored locally
    on each wiki).
  - `logging` → page-move events, to catch renames since the last rebuild.
- The replicas are a **batch/rebuild-time** tool, not in the per-edit hot path
  (the live match stays the in-RAM title set). They lag production by
  seconds-to-minutes (fine for a nightly pass) and redact some private rows (not
  the page/QID metadata we need).
- The outbound **QID → titles-across-languages** fan-out for list-building is
  still most naturally WDQS/Wikidata. Both replicas and WDQS are services we
  consume — nothing to build.

## Data model: pub/sub topics + subscriptions

Storage is **store-of-record + in-RAM index**: the DB is the durable/queryable
source of truth; the bot loads a `Map<wikipedia, Map<title, topicId[]>>` at
startup and reloads on a generation bump. The hot path stays RAM-speed.

De-duplicate the **feed**, not the **bot**. Two people who pick "Mission, places,
English" should resolve to the same shared feed; but each may want a different
delivery target (their Discord, their own account).

```
topics(id, region_qid, filters_hash, entity_filters JSON, languages JSON, generation)
       UNIQUE(region_qid, filters_hash)          -- dedup key (normalized inputs)
articles(id, wikipedia, title, wikidata_qid)     -- one row per article, ever
topic_articles(topic_id, article_id, source, score, added_at, removed_at)  -- M:N
subscriptions(id, topic_id, owner_user, delivery_type, delivery_config,
              display_name, created_at)          -- personal delivery layer
```

- `filters_hash` = hash of **normalized** inputs (QID, *sorted* entity filters,
  *sorted* languages) so "Mission+places+en" and "Mission+en+places" collide.
- **Match path:** edit → matching topics → each topic's subscriptions → deliver.
  Screenshot taken **once per edit** and fanned out (shared cost).
- **Provenance** (`source`, `score`) enables per-source tuning and diffing.
- **"New article" signal falls out for free:** a rebuild is a QID set-diff against
  the stored prior set; any new QID *is* the signal ("the Mission just got a
  Wikipedia article"). Surface it when found.
- **Topic lifecycle is decoupled from any owner:** a topic lives while ≥1
  subscription references it; GC when the last one leaves. Fixes orphaned bots —
  if the original creator deletes their subscription, everyone else's keeps
  working.

### Operational payoff

500 people "creating a Mission bot" = **1 topic, 1 build, 1 screenshot pipeline,
500 subscription rows** — not 500 identical SPARQL builds and 500× the Puppeteer
cost for the same edit.

## The create / discovery web flow

A CRUD front-end over the `topics`/`subscriptions` tables. **Discovery-first:**
search a place → show existing public bots/feeds for it → one-click follow → only
fall through to the custom form if nothing matches.

Form fields (small on purpose):

- **Auth = Wikimedia OAuth**, which is also the edit-count gate: it authenticates
  the user *and* hands you global edit count + account age directly. Gate on
  edit count + account age + not-currently-blocked. Native on Toolforge, and gives
  accountability (every bot traceable to a real Wikimedian).
- **Place** — autocomplete resolving to a QID, with description + mini-map to
  disambiguate. Validate it's place-like; fail gracefully at creation if there's
  no usable boundary/closure.
- **Entity-type checkboxes** — places / people / events / businesses, mapped to
  the query filters. "People associated with a place" is fuzzy (born/lives/worked)
  — default to places, make people opt-in.
- **Languages** — pre-checked from the place item's own sitelink languages; user
  can add/remove.
- **Live count estimate** (see below) that doubles as a **volume warning** at
  creation time ("~200 articles, roughly 30 posts/day, above the cap").
- **Delivery target** — MVP ships **Discord webhook first** (no account/OAuth
  plumbing, just a POST). Bluesky/Mastodon via bring-your-own-auth as the second
  adapter.

Submit is **async** ("your bot is building…" → job → ready) because the SPARQL
build takes seconds-to-minutes. A **dry-run preview** ("here are the last 10 edits
this would have posted", read from recentchanges history) sets expectations before
going live. Posting itself is **go-forward only**, no backfill.

### Live count estimate — resolve once, recount locally

Real-time on toggle, but **don't query per toggle**:

- When the user picks the place (one deliberate action, spinner OK — 200ms to a
  few seconds), run **one** aggregation query returning a small histogram
  bucketed by **entity class × language** (a few hundred rows regardless of region
  size), not the articles themselves.
- Every checkbox toggle is a **client-side sum over histogram cells** — sub-ms,
  genuinely real-time, zero I/O.
- Cacheable per region; if the region is already built into `articles`/
  `topic_articles`, the histogram is a local `GROUP BY` — no WDQS at all.
- It's an **estimate** by design (big-region WDQS timeouts → chunk+cache or show
  "~80,000+"; post-filters trim the raw closure). The dry-run/build is the source
  of truth.
- Count **watched pages** (across selected languages), not distinct places — pages
  are what drive post volume, which is what the estimate exists to warn about.

## Substrate: Toolforge (best-effort hobby)

- **Storage: ToolsDB (hosted MariaDB), not SQLite.** SQLite on Toolforge's NFS
  home/data storage is the bad case; use the provided MariaDB. Schema and
  topic/subscription/M:N design port over unchanged (all relational).
- **Wiki Replicas** provide the QID↔title / page-move data locally (above).
- **OAuth** — Wikimedia OAuth is first-class here.
- **Job model fits:** one continuous job for the feed listener, scheduled jobs for
  nightly rebuilds. Bounded per-job compute is what naturally caps region size.
- **Screenshots already work.** `lib/screenshot.js` is tuned for a constrained
  container: `--no-sandbox`/`--disable-setuid-sandbox` (no root),
  `--disable-dev-shm-usage` (the classic container OOM killer), `--single-process`/
  `--no-zygote` (footprint), `PUPPETEER_EXECUTABLE_PATH` (system Chromium, no
  download), plus height-capping and trim/retry fallbacks. Remaining Toolforge
  work is **operational, not feasibility**: ensure the build image ships Chromium
  at `PUPPETEER_EXECUTABLE_PATH` and request enough per-job memory.

## Abuse, safety, limits

- **PII screening still applies to every bot** — a self-serve platform multiplies
  the amplification surface the existing PII gate was built for. Reuse it.
- **Skip bot-flagged edits**; add a **per-subscription cap of X posts/hour** with a
  "your list is too big" notice; flag likely-too-big lists at creation via the
  count preview.
- **Min/max region size**, measured as **estimated article count** (reuses the
  histogram query). Does triple duty: usefulness ("all of the US" is too big to be
  useful), volume, and a surveillance floor (a "place" can't collapse to a single
  person). Note: all editor contributions are already public, so the residual
  concern is amplification, not exposure — and content moderation stays on-wiki
  for MVP.
- **Auto-name bots from the location** (with a filter suffix when two topics share
  a place but differ by filters) — sidesteps naming/squatting fights, pairs with
  public-default.
- **Bot transparency** — set the platform bot flag and label posts as automated.
- **Default public for MVP;** add private only if a concrete need appears later.

## Open questions / deferred

- **Credential death (bring-your-own delivery).** Tokens expire/get revoked and the
  bot goes silent with no signal. Post-MVP; likely answer: **post a notice to the
  creator's user talk page** (we have their identity via OAuth). Keep it
  low-frequency — a bot editing talk pages is itself under bot-editing norms.
- **Rebuild cadence.** Nightly is the likely sweet spot; the real bound is "what
  fits in a Toolforge job," which self-limits with the max-area cap.
- **Notability defaults** (min sitelinks / pageviews) — ship sane fixed defaults,
  don't expose knobs yet.
- **Canonical public-bot naming** collisions — auto-name + filter suffix.

## Suggested build order

1. **Region resolver** (`lib/region.js`): QID → `{type, polygon?, ...}`;
   `articlesForRegion()` dispatching geo vs. admin with chunking; the
   class×language **histogram** query.
2. **Topic store** on ToolsDB: schema above + `getWatchIndex()` /
   `refreshTopic()`; nightly rebuild job with QID set-diff (new-article signal)
   and Wiki-Replica title resolution / move detection.
3. **Wire the bot** to load the index from the store instead of inline config
   (small change in `inspect()` / `getConfig()`), fanning one edit → topics →
   subscriptions.
4. **Discord webhook** delivery adapter.
5. **Create/discovery web flow** + Wikimedia OAuth (extend the Express admin app):
   discovery-first, live count, dry-run, async build, minimal "my bots" list.
6. Bluesky/Mastodon **bring-your-own-auth** delivery adapters.
