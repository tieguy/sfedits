# Bay Area Elections Bot Design

## Summary

This design adds a second, independent bot account to the existing sfedits
platform — not the newer place-bot/topic system — that watches Wikipedia
articles about candidates for Bay-Area-representing offices in the November
2026 election and posts diffs to a dedicated Discord channel. Its
distinguishing feature is that nobody types in a list of articles to watch:
the watchlist is the live result of a Wikidata SPARQL query, refreshed on a
timer, with article titles resolved from Wikidata sitelinks on every refresh so
that page renames cannot silently drop coverage. Membership is anchored to
Wikidata QIDs rather than titles for the same reason.

The catch, discovered by checking live data rather than assuming it, is that the
Wikidata statements this query depends on barely exist yet for 2026 California
races. So most of the actual effort is on-wiki data repair, not code: adding
"spine" statements to the relevant election items and sourced candidacy
statements to candidates' Wikidata items, referenced to official certified
candidate lists, so that the same query which seeds the bot's watchlist is also
public, checkable evidence that the repair is correct. On the code side, the
design reuses nearly everything already built for the SFBA bot — EventStreams
matching, diff rendering, Discord delivery, revdel sweeping, watchlist caching
and outage fallback — and adds only a new watchlist-source type plus a second
account config entry. The work is sequenced as eight phases alternating data
repair (Phases 1 and 6) with code (Phases 2, 3, 5, 7, 8), piloted end to end on
a single race (CA-11) before widening to the rest of the Bay Area.

## Definition of Done

A separate bot account posts Wikipedia edits to articles about candidates for
**Bay-Area-representing offices** in the November 3, 2026 general election, to
its own Discord channel, and:

1. Its watchlist is derived **entirely from Wikidata** by SPARQL at refresh time.
   There is no curated roster file, no static title list, and no cycle-specific
   article list anywhere in the repo.
2. Consequently, its coverage on day one is near-zero, and grows as on-wiki data
   repair lands. That is accepted and intended: the bot is a live progress meter
   on the repair effort.
3. The repair effort is the first-class artifact. Candidacy statements are added
   to Wikidata with **references to authoritative third-party sources** (the
   California Secretary of State certified candidate lists and county registrar
   publications), so the accuracy claim is checkable by other editors rather
   than being a private one-time verification.
4. The CA-11 race (Chan vs. Wiener, Pelosi's open seat) is populated end to end
   as the pilot, and the bot demonstrably picks both candidates up.
5. Page renames do not silently drop articles — membership is QID-anchored, and
   titles are resolved from sitelinks at every refresh.
6. The existing SFBA bot is unaffected: its PageAssessments watchlist path and
   all existing tests remain green.
7. In 2028 the bot works with no code change and no config change, because the
   spine repaired in 2026 makes the next cycle's candidacies discoverable by the
   same query.

Explicitly **not** in scope for MVP: statewide California races (Governor et
al.), Bluesky and Mastodon delivery, and per-subscription multi-tenancy.

## Glossary

- **Wikidata**: Wikipedia's sister project for structured, machine-queryable
  data. Items (people, elections, offices) are identified by stable QIDs
  (e.g. `Q7437504`) and carry statements — property/value pairs.
- **QID**: Wikidata's permanent identifier for an item, independent of any label
  or Wikipedia article title. Used here as the anchor for watchlist membership
  specifically so that renaming a Wikipedia article does not drop it.
- **P3602 (candidacy in election)**: links a person to an election they are
  running in. The central edge the whole repair effort exists to populate — the
  watchlist query is essentially "who has a `P3602` to a 2026 election."
  Distinct from `P726` (candidate), which points the other way, from the
  election to the person; `P3602` is preferred for large elections.
- **P585 (point in time)**: a date property; used on election items so the query
  can filter to elections dated 2026.
- **P131 (located in the administrative territorial entity)**: expresses that
  one place sits inside another. Local race items can carry `P131` to a Bay Area
  county, making them query-discoverable; district items instead point to the
  whole state, which is why districts need a separate hardcoded QID list.
- **P39 (position held)**: records an office a person holds or held. Shown here
  to be unreliable as a stand-in for "current officeholder," because stale
  end-dates make former holders look current (the "10 sheriffs" finding).
- **P768 (electoral district)**: a qualifier on a candidacy statement naming
  which district the candidacy is for.
- **P1001 (applies to jurisdiction)**: links an office to the jurisdiction it
  governs; used, and shown to be incomplete, when trying to derive Bay Area
  officeholders.
- **P541 (office contested)**: names the specific office an election is for.
- **P143 (imported from Wikipedia)**: a reference type meaning "copied from a
  Wikipedia article." Explicitly forbidden for candidacy statements here,
  because it closes a loop: unsourced Wikipedia edits would become "sourced"
  Wikidata, which then becomes the bot's watchlist.
- **P361 / P155 ("part of" / "follows")**: used in Phase 1 to match the 2026
  election items' structure to the 2024 cycle, linking each item to its parent
  grouping and its predecessor election.
- **Tier 0 / Tier 1**: this design's shorthand for repair layers. Tier 0 is the
  spine — dates, jurisdiction, and office statements on the election items
  themselves, making them findable by query at all. Tier 1 is the candidacy
  edges connecting actual candidates to that spine.
- **The spine**: the Tier 0 statements that make an election item structurally
  complete and discoverable. Without it, even a fully-referenced candidacy
  statement is invisible to the watchlist query.
- **WDQS (Wikidata Query Service)**: the public SPARQL endpoint over Wikidata.
  It enforces a query-time budget per minute, which is why the existing chunked
  query helper runs chunks sequentially rather than in parallel.
- **SPARQL**: the query language used against Wikidata. Here it is the mechanism
  that replaces a static curated roster file with a live, re-runnable query.
- **Sitelinks**: Wikidata's per-item mapping to the corresponding article title
  in each Wikipedia language edition. The query's
  `schema:about`/`schema:isPartOf`/`schema:name` triple reads sitelinks
  directly, which is why no separate title-lookup step is needed.
- **QuickStatements**: a Wikidata batch-editing tool driven by tab-delimited
  input. Named as the natural tool for the Phase 6 cleanup of stale `P39`
  end-dates.
- **EventStreams**: Wikimedia's real-time feed of edits across all wikis
  (successor to the IRC recent-changes feed). The bot listens on this feed.
- **PageAssessments**: the on-wiki extension exposing WikiProject
  quality/importance ratings and task-force tags. The existing SFBA bot's
  watchlist source; this design leaves that path untouched and adds SPARQL as a
  second selectable source type.
- **Topic vs. account stanza**: two ways sfedits can host a bot. A *topic* is a
  unit in the newer place-bot platform, defined by a Wikidata region QID and
  currently Discord-only. An *account stanza* is the older per-bot config entry
  used by the SFBA bot, which already supports independent watchlists and
  multiple delivery channels. This design uses the latter because the former
  cannot represent a non-region-based roster.
- **BLP (biography of living persons)**: Wikipedia's policy category for
  articles about living people, carrying stricter sourcing requirements. Every
  watched article here is by construction a living candidate, which makes the
  existing per-post BLP badge redundant for this account.
- **Revdel (revision deletion)**: the mechanism for suppressing a specific
  revision from public view. The existing revdel sweeper, reused unchanged,
  checks whether a revision the bot already posted about has since been hidden.
- **Top-two primary**: California's format in which the two highest-vote-getters
  in the primary advance to the general regardless of party. Cited to justify
  treating primary and general as stages of one election when referencing.
- **Grapheme cluster**: a user-perceived character, which may span multiple
  Unicode code points. Bluesky's 300-character limit counts graphemes, not
  `.length`, so naive truncation miscounts.
- **congressedits**: a well-known prior bot that publicly tracked anonymous
  Wikipedia edits from US Congressional IP ranges. Cited as precedent that
  tracking edits to public officials' articles is an established, defensible
  use case.

## Architecture

The bot is a **second account stanza** in `config.json`, not a topic in the
place-bot platform. Its watchlist source is a SPARQL query against Wikidata.
Everything else — EventStreams matching, diff rendering, Discord delivery,
revdel sweeping — is existing machinery reused unchanged.

### Why not the topic platform

The place-bot platform on `integration` (`lib/topic-store.js`,
`lib/topic-index.js`, `lib/subscription-delivery.js`) is built and deploying,
and was the obvious host. It does not fit, for two independently disqualifying
reasons:

- **Topics are region-anchored.** `topics.region_qid` is required,
  `lib/topic-create.js` rejects anything not matching `^Q[1-9]\d*$`, and
  `lib/rebuild.js:27` derives membership solely from
  `articlesForRegion(topic.region_qid, …)`. A candidate roster is not a region:
  there is no boundary polygon and no `P131` closure that yields it.
- **Delivery is Discord-only.** `lib/subscription-delivery.js:121` short-circuits
  on `subscription.deliveryType !== 'discord'`. Phase 8 of the place-bot design
  (bring-your-own Bluesky/Mastodon) was never built.

Hosting this as a topic would require generalizing membership from `region_qid`
to a pluggable source *and* building per-subscription Bluesky delivery. Both are
worth doing eventually; neither is worth doing before the roster exists.

The legacy account path costs one new module and one dispatch point, and
supports Bluesky today via `page-watch.js:453`.

### Wikidata is the only source of truth

The central decision. There is no roster file the bot reads. The watchlist *is*
a query:

```sparql
SELECT ?person ?personLabel ?wiki ?title WHERE {
  ?person wdt:P3602 ?election .
  ?election wdt:P585 ?date .
  FILTER(YEAR(?date) = 2026)
  # scope filter — see "Bay Area scoping" below
  ?sl schema:about ?person ;
      schema:isPartOf ?wiki ;
      schema:name ?title .
  FILTER(CONTAINS(STR(?wiki), ".wikipedia.org"))
}
```

This has one property worth stating plainly: **a single query returns the
watchlist in the exact shape `account.dynamicWatchlist` wants**, across every
language, with no separate sitelink-expansion step. The `schema:about` /
`schema:isPartOf` / `schema:name` triple *is* sitelink expansion.

Verified live against the 2026 New York gubernatorial election (`Q117085630`),
which has real `P3602` data: 4 people → 72 `(wiki, title)` pairs across 35
languages, one query. The mechanism works today; only the California data is
missing.

The alternative — a curated `data/election-2026-roster.json` — was rejected
because it creates two sources of truth that drift, and requires someone to
remember to switch over in 2028.

### Measured state of the data

Everything below was verified live on 2026-07-30, not assumed.

**Candidacy edges barely exist.** Across all of California, exactly one person
has a `P3602` to a 2026 election: Xavier Becerra → `Q117350835` (gubernatorial,
which is out of scope anyway). Nationally there are ~28 such statements. The
model is live and in use; California is empty.

**Election items exist but are near-empty.** All five relevant items carry only
`P31=public election`, sometimes `P17`:

| Item | QID | Has |
|---|---|---|
| 2026 US House elections in California | `Q131470954` | `P17`, `P31` |
| 2026 California State Senate election | `Q133828464` | `P17`, `P31` |
| 2026 California State Assembly election | `Q133890847` | `P31`, `P2671` |
| 2026 SF Board of Supervisors election | `Q138112703` | `P31` |
| 2026 Oakland mayoral election | `Q139040246` | `P31` |
| 2026 Santa Clara County BoS election | `Q139073833` | `P31` |

No dates, no jurisdictions, no office contested, no candidates. Consequently
they are **invisible to any query that does not already know their QIDs** — a
SPARQL enumeration of "2026 elections located in California" returns the
statewide items and misses every local one.

**The `P39` fallback is worse than useless.** Querying current officeholders
whose position has `P1001` into any of the nine Bay Area counties returns 19
people, with visibly wrong counts: 10 "current" Sheriffs of San Francisco, 4
"current" SF District Attorneys, 5 of 11 supervisors, and nothing at all from
Oakland, San Jose, or any county but SF. This extends the finding already
recorded in `../sfedits-notes/IDEAS.md` from one office to the whole region.

**The roster is small.** Of 11 certified CA-11 primary candidates, 3 have
enwiki articles (Chan, Wiener, Chakrabarti) and 2 advanced to the general. If
that ratio holds, the Bay-Area-wide watchlist is well under 150 articles — small
enough that curation-by-repair is tractable within the cycle.

### Bay Area scoping, and its irreducible config

Scoping the query to Bay-Area-representing offices splits by office type:

- **Local races** (SF Board of Supervisors, Oakland mayor, county boards) —
  derivable. Their election items can legitimately carry `P131` to a county, so
  `?election wdt:P131* ?bayCounty` works once Tier 0 lands.
- **District races** (US House, State Senate, Assembly) — **not** derivable.
  Wikidata models districts as `P131` → California, not → county
  (`Q2681039` "California's 11th congressional district" has `P131 = Q99`). This
  is correct modeling — districts span counties — so it should not be "fixed."

The irreducible config is therefore a `VALUES` list of ~18 Bay Area district
QIDs. This is stable until the 2031 redistricting and is checked into the query
file, not into application code. The Definition of Done's "no cycle-specific
config" holds: a district list is decade-scoped, not cycle-scoped.

### Circularity, and why it is contained

Deriving the watchlist from Wikidata means a bad `P3602` silently expands what
the bot watches. This is contained rather than eliminated:

- `lib/wikidata-claim-watch.js` already watches Wikidata edits by property.
  Adding `P3602` to the account's `wikidata_claims.properties` makes roster
  changes *themselves* a post: "X was added as a candidate for Oakland mayor."
  Roster growth and roster vandalism become the same visible feed.
- References are mandatory on candidacy statements (see Phase 1), so an
  unreferenced addition is visibly suspect.
- **`P143` "imported from Wikipedia" must never be used as a reference here.**
  It is discouraged generally, and here it closes the loop: enwiki vandalism
  would become sourced Wikidata, which would become the bot's watchlist.

### Data flow

```
CA SoS certified lists (PDF) ─┐
county registrar lists ───────┼─→ human + Discord repair → Wikidata (P3602 + refs)
                                                                  │
                                                    SPARQL (refresh_hours: 6)
                                                                  ↓
                                              account.dynamicWatchlist
                                                                  ↓
EventStreams ─→ isWatched() ─→ render (existing) ─→ Discord (existing)
```

## Existing Patterns

Investigation of `integration` found that nearly everything this design needs
already exists in single-purpose form.

Patterns followed:

- **Store-of-record + in-RAM index with disk fallback.**
  `lib/watchlist-sync.js` caches its fetched list to `data/watchlist-<name>.json`
  so a restart during an API outage falls back to the last good list rather than
  an empty watchlist. `lib/watchlist-sparql.js` reuses this file format and
  fallback behaviour verbatim, with WDQS in the PageAssessments API's role.
- **Chunked SPARQL with retry/backoff.** `lib/sparql.js` exposes `sparqlSelect`,
  `sparqlRows`, `sparqlChunked` (sequential by design — WDQS budgets
  query-seconds per minute, so parallel chunks throttle faster). Reused as-is.
- **Periodic refresh with configurable `refresh_hours`**, timers started at boot
  by `startWatchlistSync()` / `startClaimWatch()`.
- **Per-account fan-out.** `page-watch.js:603` already iterates
  `config.accounts` for every edit; delivery is already guarded by
  `if (account.discord)` / `if (account.bluesky)` / `if (account.mastodon)`.
  A second account with independent watchlist and webhook needs **no code
  change**.
- **Per-account rate capping** via `RateCap` in `lib/delivery-limits.js`.
- **Config-stanza-per-feature** (`watchlist_source`, `wikidata_claims`,
  `pii_blocking`).

Divergences, with justification:

- **`watchlist_source` becomes a dispatch point.** It is currently hardcoded to
  the PageAssessments API. This design adds a `type` field defaulting to
  `"pageassessments"`, so the SFBA account and all existing tests are untouched.
- **Rate-cap policy is inverted.** The SFBA bot caps bursts because a burst is
  noise. Here a burst on one candidate's article *is* the signal. The cap
  becomes a generous backstop against runaway posting, not an editorial filter.
- **BLP badging becomes redundant.** The account is 100% living people by
  construction. Worse, `fetchBlpStatus`'s `missingItem` branch
  (`lib/compare-diff.js:289`) is unreachable here: the roster is derived from
  QIDs, so every watched article has a Wikidata item by definition. The
  `recently-deceased` case remains meaningful (a candidate dying mid-campaign)
  and is retained.

## Implementation Phases

Eight phases. Phases 1 and 6 are on-wiki data work rather than code; they are
phases because the bot cannot function without them and because their
"done when" is verifiable by query.

### Phase 1: Tier 0 — repair the election spine

**Goal:** Make the 2026 election items discoverable by query, and structurally
match how the 2024 cycle is modelled.

**Components:**
- On-wiki edits to `Q131470954` (2026 CA House) bringing it to parity with
  `Q116006860` (2024 CA House): `P585` (2026-11-03), `P1001` (`Q99`
  California), `P541` (`Q13218630` United States representative), `P361`
  (`Q132767622`), `P155` (`Q116006860`).
- Equivalent spine statements on `Q133828464`, `Q133890847`, `Q138112703`,
  `Q139040246`, `Q139073833`. Local-race items additionally get `P131` to their
  county, which is what makes them query-discoverable.
- `queries/bay-candidates-2026.rq` — the watchlist query, including the
  `VALUES` list of Bay Area district QIDs.

**Dependencies:** None.

**Done when:** A SPARQL enumeration of 2026 elections with Bay Area jurisdiction
returns the local-race items (it currently returns none of them). The watchlist
query parses and executes against WDQS, returning zero rows.

**Note:** These edits are made from a human account, not a bot account. Roughly
30 statements — ordinary manual-scale editing, no bot flag, no permission
required.

### Phase 2: SPARQL watchlist source

**Goal:** A watchlist whose membership comes from a Wikidata query.

**Components:**
- `lib/watchlist-sparql.js` (new) — mirrors `lib/watchlist-sync.js`'s contract
  so the two are interchangeable:
  ```js
  fetchSparqlArticles(source)                  // → [{wikipedia, title, qid}]
  refreshSparqlWatchlist(account, {dataDir})   // → count
  ```
  Reuses `lib/sparql.js` for execution and retry. Caches to
  `data/watchlist-<name>.json` in the existing format, inheriting the
  outage-fallback behaviour.
- `lib/watchlist-sync.js` — `startWatchlistSync()` dispatches on
  `watchlist_source.type`, defaulting to `"pageassessments"`.
- `test/watchlist-sparql.test.js` — nock-backed WDQS fixtures: multi-wiki
  expansion, language filtering, empty result (the day-one case) not clobbering
  a cached list, WDQS timeout falling back to disk.

**Dependencies:** Phase 1 (the query must exist and parse).

**Done when:** A fixture query populates `account.dynamicWatchlist` across
multiple wikis; an empty result preserves the prior list; a WDQS 500 falls back
to disk cache. The existing PageAssessments tests still pass.

### Phase 3: Second account stanza

**Goal:** The bot runs, watching nothing, delivering to its own channel.

**Components:**
- `config.json` — a second entry in `accounts`:
  ```json
  {
    "watchlist_source": { "type": "sparql",
                          "query_file": "queries/bay-candidates-2026.rq",
                          "languages": ["en"],
                          "refresh_hours": 6 },
    "wikidata_claims": { "properties": ["P3602"],
                         "rate_cap": { "max": 30, "window_minutes": 10 } },
    "discord": { "webhook_url": "…" }
  }
  ```
- A Discord channel and webhook.

**Dependencies:** Phase 2.

**Done when:** `node page-watch.js --noop --verbose` starts both accounts, the
new one reports a zero-length watchlist without erroring, and the SFBA account
posts unchanged.

### Phase 4: CA-11 pilot — Tier 1 edges

**Goal:** Real data, end to end, on one race.

**Components:**
- Candidacy statements on `Q110933376` (Connie Chan) and `Q7437504` (Scott
  Wiener): `P3602` → `Q131470954`, qualified `P768` → `Q2681039` (CA-11), each
  referenced to the certified **Statement of Vote** for the June 2 primary —
  the source that proves advancement, not merely filing. See "Citation
  precision" in Additional Considerations.
- Add the general-election certified list as a second reference when published
  (~late August 2026).

**Dependencies:** Phases 1, 3.

**Done when:** The watchlist query returns Chan and Wiener with their sitelinks;
the bot's next refresh picks both up; an edit to either article produces a
Discord post with a rendered diff. Wiener's article has steady edit traffic,
making this a real soak test.

### Phase 5: Integrity presentation

**Goal:** Posts that read as an integrity feed rather than a generic edit feed.

**Components:**
- Rate-cap policy inversion — the cap becomes a runaway backstop; bursts on a
  single article are not suppressed.
- Editor signals surfaced in the Discord embed: anonymous/IP, account age,
  and which section was touched.
- BLP badge suppressed for this account (`lib/discord-platform.js`); the
  `recently-deceased` case retained.
- Tests for cap behaviour under burst, and for badge suppression not affecting
  the SFBA account.

**Dependencies:** Phase 4.

**Done when:** A simulated 10-edit burst on one article produces 10 posts, not a
"+9 more" summary; embeds carry editor signals; SFBA embeds are unchanged.

### Phase 6: Widen to local races

**Goal:** Coverage beyond one district, including the races where the query is
fully self-sufficient.

**Components:**
- Tier 1 candidacy statements for SF Board of Supervisors (5 even-numbered
  districts), Oakland mayor, and Santa Clara County Board of Supervisors,
  referenced to county registrar publications.
- `P39` end-date cleanup on incumbents — the 10-sheriffs problem. This is
  batch-shaped work and the natural first use of QuickStatements.
- Bay Area district QID list completed for House / Senate / Assembly races.

**Dependencies:** Phases 1, 4.

**Done when:** The watchlist query returns candidates from at least three
distinct office types; the `P39` current-officeholder query returns plausible
counts (one sheriff, one DA, 11 supervisors).

### Phase 7: Reconciliation report

**Goal:** Make the repair worklist mechanical rather than remembered — the
long-term goal behind the MVP.

**Components:**
- `scripts/election-reconcile.js` — diffs an extracted certified candidate list
  against Wikidata state, emitting per-candidate rows: has article, has item,
  has `P3602`, has reference, `P39` sane.
- Output shaped for sharing with the Bay Area Wikipedians Discord, since the
  repair is collaborative.

**Dependencies:** Phase 6.

**Done when:** Running against the CA SoS certified list reproduces the known
CA-11 state (2 of 11 candidates with items and candidacy statements) without
hand-checking.

### Phase 8: Bluesky delivery

**Goal:** The second delivery channel, deferred until Discord is proven.

**Components:**
- A shared post-length budget helper. **`integration` has no truncation logic
  anywhere** — `lib/bluesky-platform.js` passes `text` straight to
  `agent.post()`. The SFBA template fits Bluesky's 300-grapheme limit by luck;
  politician names plus office plus summary will not, and posts will be silently
  rejected.
- An explicit priority order for what survives truncation, since Bluesky has no
  rich embed and everything Discord puts in one must fit 300 characters plus
  image and alt text.
- Tests for over-length posts, grapheme counting (not `.length`), and facet
  offsets surviving truncation.

**Dependencies:** Phase 5.

**Done when:** A post built from the longest realistic candidate name and
summary is delivered to Bluesky without rejection, with links still clickable.

## Additional Considerations

**Implementation scoping.** Eight phases, at the `writing-plans` limit. Phases 1
and 6 are on-wiki data work and should not be handed to an implementation
subagent — they need a human account making judgment calls about sourcing. A
single implementation plan should cover Phases 2, 3, 5, 7, 8.

**Prepare, then confirm.** Wikidata edits are outward-facing. Per the workflow
rules in `CLAUDE.md`, statements are prepared as reviewable batches and wait for
explicit approval before being applied. This design does not authorize any edit.

**Citation precision — pick the discriminating source.** The first draft of the
CA-11 batch cited the SoS *Certified List of Candidates*. That was wrong, and
the way it was wrong generalizes: that document lists all 11 CA-11 primary
candidates and does nothing to distinguish the two who advanced. It would
support a candidacy statement for Hurabiell or Ganezer equally well. A
reference that cannot discriminate between the claim and its neighbours is not
doing the job a reference exists to do.

The correct source is the certified **Statement of Vote**
(`.../sov/2026-primary/sov/76-us-rep.pdf`, page 79, verified 2026-07-30):
Wiener 95,816 (40.7%), Chan 69,899 (29.7%), Chakrabarti 42,060 (17.9%). Under
California's top-two primary the top two advance regardless of party, so this
document proves the specific claim being made. The certified candidate list
remains a valid *supporting* reference but must not be the only one.

No `P577` (publication date) is asserted for the SOV: the certification date is
not stated in any extractable text in the published PDFs and has not been
verified. `P813` (retrieved) is asserted and is true. Where a reference field
cannot be verified, omit it rather than inferring it from statutory deadlines.

The general-election certified list, expected late August 2026, should be added
as a second reference when it publishes — not as a replacement.

**This generalizes to Phase 7.** The reconciliation report should diff against
Statements of Vote and county canvass results, not candidate filing lists,
because only the former establish who is actually on the November ballot.

**Surveillance floor.** The place-bot design notes that amplification, not
exposure, is the residual concern for a bot like this. Candidates for public
office are the most defensible possible subject — this is the congressedits
case — but the floor still bites at the bottom of the ticket: a first-time
candidate for county supervisor with a three-sentence stub is close to a private
individual. The QID-derived roster provides a natural floor, since it only
includes people already deemed notable enough for an article. No additional
filter is proposed, but the boundary should be revisited if coverage widens
below county level.

**What breaks in 2028.** Nothing, by construction — if Phase 1 and Phase 6 are
done properly. The 2028 cycle needs new election items with spine statements and
new candidacy edges, both of which are the same work, and the query changes only
its year filter. The district `VALUES` list survives until the 2031
redistricting. This is the payoff that justifies doing repair rather than
curation.
