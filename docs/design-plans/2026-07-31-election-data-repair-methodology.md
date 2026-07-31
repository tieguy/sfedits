# Bay Area 2026 Election Data Repair — Methodology

## Summary

Wikidata has very few statements about who is running for office in the San
Francisco Bay Area in November 2026. The election items that exist are nearly
empty — typically `instance of: public election` and nothing more — and
candidacy statements are almost entirely absent. This document is a method for
fixing that, thoroughly enough that the result is trustworthy and reusable.

The work is three sequenced, separately verifiable steps. **Discover the
contests** — build an auditable register of every in-scope contest, from
certified sources, recording what each source establishes. **Validate each
election item** — bring each one up to the data model, so it can be found by
query at all. **Validate each candidate** — resolve people to Wikidata items on
corroborating evidence, and attach referenced candidacy statements. Each step
states its
sources, its acceptance criteria, and the query that proves it is done.

One commitment is firm: **every statement is sourced, and every candidacy
statement cites a source that directly supports it** — one establishing that
this person is on the November ballot, not merely that they filed. Nothing is
asserted that a reader cannot check.

Review is the second control, and it is deliberately stated as current practice
rather than a permanent promise. **Today, a human approves every statement**;
tooling produces reviewable batches with the queries that verify them and holds
no credentials. But how much of this *should* be human-reviewed is a genuine
open question — the stages differ enormously in risk, and the answer is better
worked out with the community than declared. See Open Questions.

The method is written for the Bay Area but is not specific to it. Concrete
sources are collected in the appendix rather than the body, so the same
structure applies to any region whose elections authority publishes certified
results.

Errors made while piloting this method, and the rules they produced, are
recorded separately in `../postmortem-2026-07-election-data-errors.md`.

## Motivation

Structured election data is worth having on its own terms, but this effort has a
specific driver.

The immediate use case is an **edit-watching bot**: a feed surfacing Wikipedia
edits to the articles of people running for office in the Bay Area during the
campaign, so changes to candidate biographies are visible while they matter. Its
watchlist should be derived entirely from Wikidata by query — there should be no
hand-maintained list of people — which is why the candidacy statements should
exist and be correct. The bot is documented in
`2026-07-30-bay-area-elections-bot.md`.

Two consequences shape decisions later in this document:

- **Coverage is visible.** The bot watches whoever the data says is a candidate,
  so gaps in Wikidata are gaps in the feed. Repair work becomes legible as
  progress rather than invisible maintenance.
- **Errors travel.** A wrong candidacy statement is not merely a bad row. It is
  a false claim that a named living person is running for public office, and the
  bot repeats that claim off-wiki where no editor can revert it.

To be clear about what is *not* the concern: attention to the biographies of
people seeking public office is a benefit, not a hazard. That is what
`Wikidata:Living people` and enwiki's BLP policy ask for, and surfacing edits to
candidate articles during a campaign is a well-established public good. The risk
runs the other way — that someone who is **not** a candidate is asserted to be
one, or that a namesake is linked in place of the real person.

Amplification becomes a genuine concern only at the bottom of the ballot, where
a first-time candidate for a minor local body is closer to a private individual
than a public figure. That is a scope question, handled by the floor in Gate 1.

Nothing in the method depends on the bot. A reader who thinks the bot is a bad
idea can still evaluate the data work on its merits.

## Definition of Done

1. A **contest register** exists listing every in-scope contest on the November 3,
   2026 ballot, each with its authoritative source, its Wikidata election item
   (existing or created), and its certified candidate roster.
2. Every election item in the register satisfies the **data model** for its
   contest class — the Step 2 completeness query returns no missing-property rows.
3. Every candidate is either linked with a referenced candidacy statement,
   recorded as reviewed-and-ambiguous, or recorded as having no Wikidata item.
   No candidate is silently absent.
4. Every candidacy statement sits on an item that is **`instance of: human`**
   (`Q5`). Wikidata has items for disambiguation pages, organisations and
   fictional characters that carry a person's name as their label, so requiring
   `Q5` is what prevents a candidacy being attached to something that is not a
   person at all. Election items are exempt — they are deliberately not `Q5`.
5. Each candidacy statement cites a source that **directly supports it** —
   establishing the person is on the November ballot, not merely that they
   filed.
6. The register, the worklist and every applied batch are **published on-wiki**,
   where the editors affected by this work can find them without going to an
   external site. That also makes the next cycle cheaper: prior sources,
   resolved QIDs and modelling decisions are all reusable.

## Glossary

- **Data model**: the set of properties an election item is expected to carry —
  date, jurisdiction, office contested, series links — which is what makes it
  findable by query. Without them, even a correct candidacy statement cannot be
  retrieved, because nothing connects the election to a date or a place. Several
  WikiProjects publish a data model page in this sense; the requirements here
  could also be expressed formally as an **EntitySchema** (`Wikidata:Schemas`).
- **Contest register**: the committed inventory of in-scope contests. Step 1
  produces it; Steps 2–3 consume it.
- **Certified results publication**: the elections authority's official,
  county-by-county record of votes cast. In California this is the Secretary of
  State's *Statement of Vote* (SOV); the appendix gives locations.
- **Directly supports**: enwiki's verifiability standard, applied here to mean a
  source that establishes *this* claim rather than a neighbouring one. A
  certified *candidate list* for a primary does not establish which two
  candidates advanced from a field of eleven; the results publication does.
- **Reconciliation score**: the weighted `P31`/`P39`/`P106`/`P27`/sitelink
  signal used to rank name→QID matches, replacing label equality. Named after
  OpenRefine's reconciliation vocabulary, which is the standard tooling for this
  problem on Wikidata.
- **Confident / Ambiguous / No-item**: the three reconciliation tiers. Only
  Confident generates statements, and those are still human-reviewed.
- **P3602 vs P726**: two directions for one fact. `P3602` (candidacy in
  election) sits on the person; `P726` (candidate) sits on the election. Which
  is idiomatic, and whether it should vary by contest class, is **an open question**
  — this document records a reading inferred from a handful of existing items,
  not an established convention. See Open Questions.
- **Statewide-parent contest**: a contest whose *election item covers the whole
  state* while the office represents only part of it — US House, State Senate, State
  Assembly. Regular cycles get no per-district election item, so candidacies
  hang off a statewide parent qualified with `P768`. Because district items are
  modelled `P131` → the *state*, never → county, these contests cannot be
  identified as Bay Area ones by query alone.
- **Local-item contest**: a contest whose *election item covers a single county or
  city*, and can therefore carry `P1001` to that jurisdiction, making it
  geographically discoverable with no maintained list.

  The split is about the jurisdiction of the election item, not the level of
  government, and it determines three things: the data model, the statement
  direction, and whether scoping needs configuration. Under the current floor
  these coincide with the everyday sense of "local", so this document says
  "local contests" in prose and reserves "local-item" for the scoping discussion.

## Scope

Scope is decided by **two gates in order**. A contest must pass the floor to be
considered at all, then clear the bar to enter the register.

### Gate 1 — the office-class floor (editorial, hard)

In scope: federal, state legislative, county offices, and major-city offices.
Out of scope: municipal offices below the major-city line, school boards, and
special districts.

This is a deliberate editorial judgment, not a derived one. Its purpose is to
stop well above the point where a candidate stops being a public figure in any
meaningful sense. Someone standing for Congress, the legislature, a county board
or a city council in a substantial city has sought public office and public
scrutiny; a first-time candidate for a minor local body has not, to anything
like the same degree. **That line must not be decidable by the accident of
whether someone happens to have a Wikidata item**, which is what would happen if
the mechanical bar in Gate 2 were the only control.

**"Major city" means population ≥ 100,000, or the seat of one of the nine
counties.** Both are checkable against Wikidata (`P1082`, `P36`), so the line is
editorially chosen but mechanically applied. That gives sixteen cities over the
population line plus four county seats below it — about twenty municipalities.
San Francisco is covered as a county, being a consolidated city-county. The
county-seat clause exists because county government sits there and is covered
accordingly, even where the city is small.

**Charter-city status was considered and rejected as the line.** It is close to
uncorrelated with significance: it would exclude Fremont — the region's
third-largest city — along with Hayward, Fairfield and Daly City, while
admitting Piedmont and Emeryville at around 10,000 each. It is also unstable in
the wrong way: cities convert by ballot measure for unrelated fiscal reasons, on
timelines that could move the boundary mid-cycle.

**Revisit the floor before planning the next cycle**, not during this one. It is
a judgment made with limited experience of what each tier costs; the time to
widen or narrow it is once this cycle has been completed and measured. Any
change is made by explicitly moving Gate 1 — never by loosening Gate 2, and
never by admitting a borderline contest because one candidate turned out to be
notable.

### Gate 2 — the derivable bar (mechanical, within the floor)

Among contests passing the floor, a contest enters the register if **either** enwiki
already has an article for it, **or** at least one certified candidate has a
Wikidata item. Both are mechanically checkable, and both are evidence that
someone independent of this project already judged the subject notable.

This applies uniformly to every contest class, including districts — which is why
there is no vote-share threshold (see Step 1A).

### Also settled

- **Strategy**: contests enumerated top-down and exhaustively within the floor;
  candidates worked bottom-up within each contest.
- **Missing items**: created, following precedent — with the caveat in Step 2
  that the useful precedent for local contests is not the local prior-cycle items.

## Step 1 — Research: build the contest register

**Goal:** an auditable inventory of every in-scope contest, with sources.

### Re-discover every cycle; never carry forward

The register makes the next cycle cheaper, but Step 1 must be re-run against
sources rather than diffed from the previous register. Contests appear and
disappear for reasons no diff predicts:

- **Voting-rights settlements convert cities from at-large to district
  elections**, creating seats that did not previously exist. In California the
  Voting Rights Act has driven 600+ local bodies to convert since 2002, on
  litigation timelines rather than schedules.
- **Boundaries move mid-decade.** California redrew its congressional districts
  by ballot measure in November 2025, effective for 2026–2030.

Carrying a register forward silently misses both.

### 1A. Federal and state legislative — mechanically derivable

The state's certified results publication covers every US House, State Senate
and State Assembly contest, one workbook per office class (see appendix). Each
district block lists per-county vote totals, so **Bay Area membership is derived
from the documents themselves** rather than from any maintained district list.

**A district is in scope if any of its counties is a Bay Area county.** There is
no vote-share threshold, because share of a district's electorate does not
measure whether an office represents Bay Area constituents: one Assembly
district is 18% Santa Clara and is held by the Speaker of the California State
Assembly, and one congressional district is 42% Sonoma and includes the Senate
president pro tem. Any cutoff high enough to be meaningful excludes them.

Bay-Area share is recorded as register metadata for prioritising review, but it
is not a gate.

Under California's top-two rule the two highest vote-getters advance, so for
this tier the results publication is simultaneously the contest list, the candidate
list, and the source that directly supports each candidacy.

Baseline measured 2026-07-31: 34 districts touch the Bay Area, yielding 67
advancing candidates — 32 resolving confidently to Wikidata items, 9 ambiguous,
26 with no item (mostly minor-party challengers in safe seats).

**One further pass is required**, not further discovery: the general-election
certified list publishes in late August and must be checked for withdrawals,
deaths and substitutions.

### 1B. County offices — a source-discovery protocol

Supervisors, District Attorney, Sheriff, Assessor and equivalents across the
nine counties. There is no state-level aggregation; each county publishes
independently.

**County entry points are register data, not document content.** Their URLs,
access modes and retrieval dates are recorded per county with the rest of the
provenance. County sites are reorganised aggressively and any list hardcoded
here would rot; the state-level sources in the appendix are stable enough to
name, county ones are not.

**Discovery order.** For each county, work down until a source is found:

1. The county elections office or Registrar of Voters site — find the November
   2026 election page, then its candidate list.
2. The county Clerk, where elections sit under that office.
3. The state's published directory of county elections officials — the reliable
   way to find an office whose site has moved.
4. Direct contact with the elections official.

**Acceptance criteria.** A source is usable when published by the elections
official (not a news outlet or aggregator), dated or versioned, and enumerating
the November ballot for that contest. Capture the URL, the retrieval date, and
an archive snapshot at retrieval time — a reference that 404s in two years is a
reference that cannot be checked.

Ballotpedia, news coverage and candidate websites may be used **to guide
discovery** — to learn a contest exists, or that someone is running. They are never
the reference on the resulting statement.

**When a source is missing or unreachable**, record the state; do not silently
skip the county.

| Situation | Action | Register state |
|---|---|---|
| Blocked to automated fetch (403, robots, JS-only) | Retrieve manually in a browser | `manual` |
| Not yet published | Re-check after the filing deadline; record the expected date | `pending` |
| Site moved or reorganised | Rediscover via the officials directory | `moved` |
| No published list at all | Email the elections official; record the request and date | `requested` |
| Refused or unanswered | Escalate to a public records request | `escalated` |

A county in any state other than `retrieved` is a visible gap, not an omission.
**The register must account for all nine counties even when some have no usable
source**, so missing coverage is legible rather than looking like an absence of
contests.

Some counties will require a human with a browser. That is a property of the
sources, not a tooling failure, and it is the honest argument for doing this
tier collaboratively rather than waiting on a scraper that would half-work.

### 1C. Major-city offices

Mayoralties and council seats in the municipalities meeting the Gate 1 major-city
line.

The 1B protocol applies unchanged, with two differences. Sources sit with the
**city clerk** rather than a county registrar, though counties often conduct
municipal elections and may publish the authoritative canvass instead — check
both. And **most municipal contests have no primary**, so every certified candidate
appears on the November ballot rather than a top two; expect several candidates
per contest, and note that several Bay Area cities use ranked-choice voting,
which does not narrow the field either.

Consequently this tier produces more names per contest than 1A, and a larger
`no_item` tier. That is expected and is not a reason to relax Gate 1.

### The register is edit-time, never run-time

The companion design rejects a roster file because two sources of truth drift.
The register does not reintroduce one:

> **The register is an input to the editing process. Wikidata is the only input
> to the bot.** Nothing in the register can affect what the bot watches except
> by first becoming a Wikidata statement.

Three consequences make that real:

1. **No code on the bot's runtime path may read the register** — not as a
   fallback, not as a warm-start cache. This is enforceable by a test asserting
   nothing under the watchlist or delivery path references it.
2. **The register cannot fix coverage.** A candidate in the register but not in
   Wikidata is not watched, and the correct response is the Wikidata edit, never
   a special case in the bot.
3. **The register may be stale without consequence.** It records what sources
   said on a date; Wikidata is what is true now. Their disagreement is what Step
   3 reconciles.

The register's jobs are provenance, worklist, and a starting point for the next
cycle.

### Where the register lives

**Published on-wiki, in the maintainer's user namespace** — the register as a
readable table, the applied batches, and the worklist of what remains unlinked.
Wikidata editors are the people with standing to check this work, and they
should not have to find a GitHub repository to do it. On-wiki also gives page
history, watchlisting and talk pages for free, which is the review apparatus the
community already uses.

A working copy lives in the repository, since the tooling reads and writes the
structured form, but **the on-wiki copy is the published artifact** and any
discrepancy is resolved in its favour.

In the repository it sits under `wikidata/`, deliberately **not** under `data/`,
which holds runtime artifacts: a reader finding it there would reasonably assume
the bot reads it. The separate directory keeps the edit-time/run-time boundary
visible and gives consequence (1) an unambiguous path to assert against.

```
race_id, office, jurisdiction,
race_class ("statewide-parent" | "local-item"),
district_or_seat, bay_share (statewide-parent contests only),
wikidata_item (or "MISSING"), enwiki_article (or null),

source_url, source_kind, source_establishes ("november-ballot" | "filed-only"),
access_mode ("retrieved"|"manual"|"pending"|"moved"|"requested"|"escalated"),
archive_url, retrieved_date,

candidates[ { name, party, votes, advanced,
              wikidata_item (or null), tier ("confident"|"ambiguous"|"no-item"),
              rival_items[] } ]
```

`source_establishes` is what Step 3 gates on, not `source_kind`. A filing list
may still establish the November ballot — the normal case for contests with no
primary. What Step 3 refuses is `filed-only`: a pre-primary roster for a contest
that had a primary.

`tier` and `rival_items` are written by Step 3, so a reviewer can see what a
match was chosen *over*.

**Done when:** every in-scope contest appears once, with a resolving source and a
`race_class`; a second pass over the same sources produces no additions.

## Step 2 — Validate each election item

**Goal:** every election item in the register is structurally complete and
query-discoverable.

### Where the template comes from

For statewide-parent contests, the prior cycle's equivalent item is a good model —
it already carries date, jurisdiction, office contested and series links, so the
argument for any reviewer is simply that this cycle should match the last one.

For local contests the prior cycle is **not** a usable model. Checked 2026-07-31,
the 2024 Bay Area local election items carry only `P31`, sometimes `P17` — one
adds `P1001`. Copying them copies nothing. The template instead comes from
well-modelled US local elections elsewhere: the New York City, Boston, Chicago
and Los Angeles mayoral items are consistent with each other and complete.

### The data model

**Statewide-parent contests** — US House, State Senate, Assembly

| Property | Value |
|---|---|
| `P585` point in time | the general-election date |
| `P1001` applies to jurisdiction | the state |
| `P541` office contested | the office item |
| `P361` part of | the national or statewide parent |
| `P155` follows | the previous cycle's equivalent |

**Local-item contests** — county and municipal

| Property | Value |
|---|---|
| `P585` point in time | the general-election date |
| `P1001` applies to jurisdiction | the county or city item |
| `P541` office contested | the office item |
| `P31` instance of | the election-series class where one exists, else `Q40231` |
| `P155` / `P156` follows / followed by | the adjacent cycles |

`P991` (successful candidate) is out of scope until after November for both.

`P1001` is load-bearing for local-item contests: it is what makes them discoverable
geographically, with no list of QIDs maintained anywhere.

### Scoping statewide-parent contests — the one declared exception

Local-item contests need no configuration: ask Wikidata for 2026 elections whose
`P1001` is one of the nine counties.

Statewide-parent contests cannot be scoped that way. Their election item is
statewide while the office is sub-state, and district items are modelled `P131`
→ the state, never → county. **No query identifies the Bay Area subset from
Wikidata alone.**

So the bot's query carries a `VALUES` list of district QIDs — an input to the
live bot that is not Wikidata, and therefore an exception to the invariant
above. It is declared rather than left implicit, and constrained:

**The list is generated, never hand-maintained.** It is regenerated from the
current cycle's results publication as part of each register rebuild, and
committed with its source and date. Boundaries do not move on a schedule that
can be assumed — California's congressional districts changed mid-decade — and a
list carried forward is wrong silently, returning plausible results while
watching the wrong districts. Generating from the results publication removes
any dependence on redistricting schedules, because that document necessarily
reflects the boundaries actually used.

The exception is therefore testable: regenerate, diff against the committed
list, and a non-empty diff means the query must be republished. Silent staleness
becomes a failing check.

This is narrower than "districted contests". County supervisorial and city council
seats are districted too, but their election item carries `P1001`, so they scope
without configuration. The exception covers only the statewide-parent election
items.

### Creation policy

Create a missing item only when the register entry has a source and a
`race_class`.

**Naming.** There is no single established pattern — observed items include
adjectival forms, office-name forms, and plural county omnibus forms. So:

1. If enwiki has an article for the contest, mirror its title exactly.
2. Otherwise mirror the prior-cycle item for the same jurisdiction and office.
3. Never invent a third form for a jurisdiction that already has one.

**Search before creating.** Name-pattern search is a starting point, not a
check: it misses items filed under variant names and returns confident false
matches from elsewhere in the world, since place names repeat across countries.
Confirm a candidate item by its jurisdiction and date, never by its label.

### Notability

`Wikidata:Notability` admits an item on **any one** of three criteria: a valid
sitelink to a Wikimedia project; being an instance of a clearly identifiable
entity describable with serious and publicly available references; or filling a
structural need.

**Election items created here qualify under criterion 2.** A certified election
for a named public office, documented by an official canvass published by the
responsible elections authority, is a clearly identifiable entity with
impeccable public references. Criterion 3 also applies — the item is what makes
candidacy statements retrievable — but criterion 2 should be the argument
offered, because a structural need created by one's own project is a weaker
claim and invites the objection rather than answering it.

**Candidates linked here raise no notability question.** Statements attach only
to items that already exist; nothing in Step 3 creates an item for a person.

**Creating person items for candidates who lack them is out of scope.**
Criterion 2 would arguably permit it, but it is a different undertaking: roughly
150 new biographical items for largely private people, built from a single
primary source — which is where notability and living-persons concerns genuinely
bite. The `no_item` tier is a record of coverage gaps, not a worklist for
creation.

### Verification

One query over the whole register, returning **one row per missing required
property**. An empty result means every election item is complete, and because
the query is generated from the register, re-running it regression-tests all of
them,
including items repaired in earlier passes.

```sparql
SELECT ?item ?itemLabel ?missingLabel WHERE {
  VALUES (?item ?missing) {
    (wd:Q131470954 wd:P585) (wd:Q131470954 wd:P1001) (wd:Q131470954 wd:P541)
    (wd:Q131470954 wd:P361) (wd:Q131470954 wd:P155)
    # … one pair per (register item × required property for its class)
  }
  ?missing wikibase:directClaim ?dc .
  FILTER NOT EXISTS { ?item ?dc [] }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en". }
}
ORDER BY ?itemLabel
```

Binding the property as an entity and dereferencing `wikibase:directClaim` is
what lets one query check heterogeneous per-class requirements without
enumerating them in code.

**Done when:** the missing-property query returns nothing for every register
entry, and a geographic query for 2026 elections in the nine counties returns
every local-item contest.

## Step 3 — Validate each candidate

**Goal:** every candidate correctly linked, or explicitly recorded as not
linkable. This step carries the most risk and is specified hardest.

### Why names cannot be matched on names

Matching a candidate's name against Wikidata labels fails in two ways that are
common rather than exotic, and it fails *confidently*.

The first is disambiguation pages: Wikidata has items for them, and they carry
the plain name as their label, so a name can match both a disambiguation item
and the person, with nothing in the label to separate them.

The second is namesakes. Bay Area candidates in this cycle share exact names
with an actor who died in 2002, a cricketer born in 1868, and a film producer.

Measured over 67 candidates, reconciliation scoring returns 32 confident, 9
ambiguous and 26 with no item, with one known wrong item in the confident tier.
On the subset of 52 where label matching was also run, it returned 30 matches of
which at least 5 were the wrong person — roughly 1 in 6, against roughly 1 in 32.

The rule that follows: **never accept a name→QID match on a label.** Require
`P31 = Q5` as a hard gate, rank on corroborating evidence, and treat a close
second place as a reason for review rather than a tiebreak to resolve
automatically.

### Reconciliation contract

```
reconcile(register) -> { confident[], ambiguous[], no_item[] }

score(item) = 3*(P106 = politician)
            + 3*(has any P39)
            + 2*(P27 = United States)
            + 1*(has an enwiki sitelink)

hard filter: P31 = Q5.  Items failing this are discarded, never ranked.
confident := score >= 6 AND strictly greater than the runner-up
```

The `P31 = Q5` filter is the fix for the disambiguation trap; the
strictly-greater-than-runner-up clause is the fix for common names.

**The confident tier is not clean, and must still be reviewed.** The score
measures whether an item is a plausible American public figure, not whether it
is the person who ran in this contest in 2026. A long-dead labour leader satisfies
every signal and is still the wrong answer, so raising the threshold discards
real matches without excluding it. Mandatory review is what the residual rate
buys, and no tuning replaces it.

**No tier writes to Wikidata directly.** `confident` emits a reviewable batch;
`ambiguous` emits a review list with each rival item and its description;
`no_item` becomes the coverage-gap worklist. Most of `no_item` will be
minor-party challengers in safe seats who are correctly non-notable — a finding
to record, not a backlog to clear.

### Direction: `P3602` or `P726` — unsettled

**This is the least confident part of the method, and it should be settled with
WikiProject Elections before scaling.** What follows is a working assumption
inferred from a small number of existing items, not an established convention,
and the sample is too small to support the word "idiomatic".

The working assumption:

- **Statewide-parent contests** — `P3602` on the person, qualified `P768`
  (electoral district). The supporting observation is that no per-district items
  or enwiki articles exist for regular CA House cycles in 2020, 2022 or 2024 —
  only for special elections — so there is no per-district item to attach `P726`
  to, and hanging candidacies off the statewide parent is the available option
  rather than a preference.
- **Local-item contests** — `P726` on the election item, matching how the New York
  City, Boston, Chicago and Los Angeles mayoral items are built. **Four items is
  an observation, not a convention.**

What we do not know, and should ask: whether mixing directions by contest class is
normal practice or an artefact of how those particular items were built; whether
either property is deprecated in favour of the other; whether `P726` becomes
unwieldy on items for contests with many candidates, which several no-primary local
contests will be; and whether there is guidance we have not found.

Recording it here means the assumption is visible and correctable, rather than
silently baked into a few hundred statements.

**Either way, this has a consequence for the bot.** Its watchlist query must be
bidirectional — which also makes it robust to the answer changing — and must
carry the `Q5` gate permanently so a disambiguation page can never enter the
watchlist even if one is mis-linked:

```sparql
{ ?person wdt:P3602 ?election } UNION { ?election wdt:P726 ?person }
?person wdt:P31 wd:Q5 .
```

### Referencing

Every candidacy statement carries `P854` (reference URL), `P1476` (title) and
`P813` (retrieved). `P577` only when the publication date is stated in the
document — never inferred from statutory deadlines.

**The test, stated as a principle rather than a list of acceptable document
types:**

> The source must establish **who is on the November ballot** — not merely who
> filed, and not merely who exists.

How that is satisfied depends on the contest:

- **Top-two contests** (federal, state legislative, and county offices that held a
  primary): the certified primary *result* proves advancement. A pre-primary
  filing list does not.
- **Contests whose first contest is November** (many municipal and some county
  offices): no result exists or will before the election, so the general-election
  **certified candidate list directly supports the claim** — it enumerates
  exactly the people on that ballot.

The test is on what a document *establishes*, never on what it is called. A
blanket "never cite a filing list" rule would make every no-primary contest
permanently unlinkable, and jurisdictions publish formats not anticipated here.

`P143` (imported from Wikimedia project) is prohibited outright: the bot's
watchlist derives from Wikidata, so sourcing Wikidata back to Wikipedia closes
the loop.

### Batch hygiene

**A removal takes no qualifiers** (`-QID|P3602|Q…`) — supplying them causes
QuickStatements to split the line into a malformed second command.
QuickStatements also decomposes one input line into several commands —
statement, qualifiers, references — so an "N/N with errors" summary must be read
per row.

Neither the batch summary nor the absence of errors is evidence of correctness.
**The verification query is**, and every generated batch ships with the query
that checks it.

**Done when:** every register candidate is in exactly one tier; the confident
tier is applied and verified; no candidacy statement sits on a non-`Q5` item;
every candidacy statement has a reference that directly supports it.

## Automation, AI involvement, and what "reviewed" means

The document asserts "human-reviewed" throughout; this section says what that
consists of. It is written to be lifted into the on-wiki proposal, on the
expectation that the community will demand more rigor here, not less,
particularly once AI involvement is known.

### What is automated, and by what

An LLM-assisted toolchain (Claude, driven interactively) downloads and parses
the published results workbooks, computes per-district Bay Area vote share and
advancement, proposes name→QID matches with reconciliation scores, generates batches
and their verification queries, and drafted this document.

**It holds no Wikimedia credentials, has no account, and makes no edits.** Every
statement reaching Wikidata passes through QuickStatements under a named human
account, from a batch a human has read.

### Known failure modes and measured rates

Reliability here is a measured quantity, and the measurement is deliberately
unflattering.

**Name resolution is the weak point.** Automated matching produces confident
wrong answers, because the signals that make an item look like a plausible
politician are satisfied by namesakes, disambiguation items and historical
figures.

| Method | Matches returned | Known wrong |
|---|---|---|
| Label matching (52-candidate subset) | 30 | ≥ 5 |
| Reconciliation scoring (full 67; `Q5` gate + weighted signals) | 32 confident | 1 |

**An order of magnitude better, and still not zero.** No threshold tuning closes
the gap, because the score measures plausibility rather than identity. That
residual rate is why **name resolution specifically** is reviewed rather than
trusted, and why the checklist below asks questions the generator did not ask.
It is also the reason the automation question later in this section is answered
per stage: the other stages do not carry this kind of error.

Both methods produced live errors during the CA-11 pilot, including a statement
written to a disambiguation page. Those incidents, their root causes and the
rules they produced are documented in
`../postmortem-2026-07-election-data-errors.md`. Anyone evaluating this proposal
should read it — it is the evidence for the safeguards, and it is public for
that reason.

### The reviewer checklist

Per proposed candidacy statement, a human confirms before the batch runs:

1. The target item is `P31 = Q5` — not a disambiguation page, not an
   organisation, not a namesake class.
2. Its description, occupation or held positions are **consistent with a 2026
   Bay Area candidate**. A labour leader who died in 1895 fails here.
3. It is not obviously a different person of the same name — check dates of
   birth and death, nationality, and the enwiki article if one exists.
4. The cited source actually names this person for this contest. Open it.
5. The qualifier district or jurisdiction matches the source.

Per election-item statement, a human confirms the item is the right election, the
jurisdiction and office are correct, and the date is the general-election date.

### Standing commitments

- Every statement carries a reference a reader can check. This one is not
  negotiable and does not vary by stage.
- Batches are capped in size and applied incrementally, so any single error
  affects a reviewable number of statements.
- The register and every applied batch are published on-wiki, so any editor can
  audit what was added and on what evidence without leaving the project.
- Every generated batch ships with the query that verifies it.
- A challenged statement is reverted first and discussed after.

### How much should be automated — an open question

Current practice is that a human approves every statement. That is the right
starting point for an unproven method, but it is not obviously the right steady
state, and it does not scale to further cycles or regions.

The useful observation is that **risk is not uniform across the pipeline**, so a
single answer for the whole method is probably wrong:

| Stage | What could go wrong | Exposure |
|---|---|---|
| Parse certified results into the register | Misparse; caught by checking totals against the source document | Low — mechanically verifiable |
| Data-model statements on election items | Wrong date or jurisdiction on an election item | Low — fixed template, no living-person claims |
| Attach references to decided statements | Wrong URL or retrieval date | Low — mechanical |
| Resolve a name to a QID | Wrong person asserted to be a candidate | **High** — measured false positives, living-person claim |

Name resolution is the stage that carries nearly all the risk, and it is the
stage where the measured error rate is non-zero. The other three are ordinary
data processing.

So the question worth putting to the community is not "should this be a bot?"
but **which stages are safe to automate, under what controls** — a bot flag and
`Requests for permissions/Bot` for the mechanical stages, spot-check sampling
rather than exhaustive review, an error-rate threshold that triggers a return to
full review, or something else established practice already knows.

This document does not presume the answer. It commits to the sourcing rule
absolutely, applies full review while the method is unproven, and treats the
boundary as something to be set with the community rather than announced to it.

## Open questions

These are genuinely undecided, and are the points on which community input would
change what gets done. They are listed here so the on-wiki version can carry
them unchanged.

**1. Which stages should be automated, and under what controls?** The detailed
version is above. Short form: name resolution carries nearly all the risk;
parsing, data-model statements and reference attachment are ordinary data
processing. A single answer for the whole pipeline is probably wrong.

**2. Statement direction per contest class.** This document proposes `P3602` on the
person for statewide-parent contests (following how large elections are modelled,
and because no per-district election items exist for regular cycles) and `P726`
on the election item for local contests (following the NYC, Boston, Chicago and LA
mayoral items). Consistent with practice as observed, but a project that works
in this area daily may know better.

**3. Should congressional and legislative district items carry `P131` to the
counties they cover?** Today they are modelled `P131` → the state, which is why
Bay Area district contests cannot be identified by query and why this method needs
a generated district list. Adding county-level `P131` would make them derivable.
It is defensible on the merits — a district genuinely is located in several
counties — but it is a modelling change across many items, made to suit one
project's query, and should not be done unilaterally.

**4. Required properties for local election items.** The prior-cycle Bay Area
items are nearly empty, so the data model here is drawn from better-developed
mayoral items elsewhere. Whether that is the right template, and whether it
should be formalised as an **EntitySchema**, is worth settling with people who
maintain election data generally rather than for one region.

**5. Creating county- and city-level election items.** Argued above as satisfying
notability criterion 2. If the community disagrees, local coverage largely does
not happen, so it is better to know early than after a hundred items exist.

**6. The scope floor.** Federal, state legislative, county, and cities over
100,000 or county seats. Deliberately conservative for a first cycle. Both
directions are arguable: too narrow to be useful, or too broad given that
candidates for smaller offices are closer to private individuals.

## Risks

**A false candidacy claim about a living person.** The most serious failure
mode. Linking a namesake or a disambiguation item asserts that a named living
person is standing for public office when they are not — a `Wikidata:Living
people` problem, worsened because the bot repeats the claim off-wiki where no
editor can revert it. Mitigations: the `Q5` hard gate, evidence-based
resolution, the reviewer checklist, and revert-first on challenge.

**Effort without additive value.** The standard and fair objection to imported
data. Expected volume, stated plainly rather than minimised: roughly **65–90
candidacy statements and 115–200 statements on election items** — low hundreds
in total, most of it structural data rather than statements about people.

This is not a bulk import and not machine-generated beyond review. But a batch
modest enough not to alarm anyone also attracts less scrutiny, so an error can
persist unnoticed precisely because the volume is unalarming. The defence is
therefore not volume but sourcing: every statement carries a reference a reader
can check, which is what separates this from an import that merely asserts.

**Notability pushback on created items.** Creating county-level election items
is defensible but more visible than repairing existing ones. Mitigation: create
only entries clearing Gate 2, name them in the established pattern, and lead
with contests that already have enwiki articles.

**Local sourcing is genuinely manual.** Several county sites resist automated
access and formats differ. Budget this as collaborative human work; do not plan
a scraper that will half-work.

**The register can rot before November.** Candidates withdraw and die. Re-verify
against sources once the general-election certified list publishes.

**Scope creep downward.** Gate 1 is the control, and it is deliberately
editorial. If school-board or minor municipal contests start appearing, the floor
was applied wrongly — it is not relaxed because a particular candidate turned
out to be notable.

## Appendix — sources

Locations current as of 2026-07-31. Kept out of the body so the method reads as
portable; a different state or cycle substitutes its own equivalents.

**California certified results (Statement of Vote), June 2026 primary.** One
workbook per office class, published as both PDF and `.xlsx`; the spreadsheets
are what the tooling parses.

```
https://elections.cdn.sos.ca.gov/sov/2026-primary/sov/76-us-rep.xlsx
https://elections.cdn.sos.ca.gov/sov/2026-primary/sov/90-state-senator.xlsx
https://elections.cdn.sos.ca.gov/sov/2026-primary/sov/95-state-assembly.xlsx
```

**California certified list of candidates.** Published per election at the
Secretary of State's statewide-elections path; the general-election edition is
expected in late August 2026.

**County elections officials directory.** The Secretary of State publishes a
contact list for all 58 county elections offices each cycle — the reliable way
to locate a county office whose site has moved.

**County and municipal sources** are recorded per contest in the register, not
here, for the reasons given in 1B.
