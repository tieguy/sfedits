# Importance ranking: methodology, experiments, and conclusions

Last verified: 2026-07-30

This document records how the SFBA importance-ranking metric was evaluated and
rebuilt, what was measured, what was rejected and why. It exists so that the
negative results are not re-litigated, and so the choices can be defended on-wiki
by someone who wasn't in the room.

It deliberately separates **what was measured** from **what was decided**, because
several decisions rest on judgement calls that reasonable people could make
differently.

---

## 1. What this is for

`scripts/reassess.js` is a local analysis tool. It is never deployed to Toolforge
and never run by the bot.

The bot (`page-watch.js`) posts diff images for edits to Bay Area articles. Its
dynamic watchlist comes from PageAssessments — articles the SFBA task force tagged
at a given importance. So the bot's coverage is downstream of those ratings, and
the ratings turned out to be unreliable: the sitting mayor of San Francisco was
rated Mid (so unwatched), while Netflix and Steven Weinberg sat at High (so
watched).

The tool was built to find those errors. This document covers the analysis that
followed, which went considerably further than the original ask.

### 1.1 Two jobs, not one

A late and important finding (§7) is that the tool is doing **two separable jobs**:

| Job | Question | Signal |
|---|---|---|
| **Relevance gate** | Is this article *about* the Bay Area? | `lead`, weakly `entangle` |
| **Importance rank** | Among relevant articles, which matter most? | canonical inlinks |

Conflating these caused a wrong conclusion partway through the analysis. Any
future work should keep them distinct.

---

## 2. On-wiki context

Facts established by research, relevant to anything proposed on-wiki.

### 2.1 The task force has its own 2007 importance criteria

At `Wikipedia:WikiProject California/San Francisco Bay Area task force/Assessment`.
Written largely by Wikidemo in August 2007. Key text:

- **Top** — "a 'core' or 'key' topic for the SFBA, is widely famous worldwide…
  counties; the largest cities; main subject articles; major universities; iconic
  structures and major geographic features known outside the area; and critical or
  defining events and persons."
- **High** — "county seats (not already in the Top list); cities of particular
  importance or populations above 80,000 to 100,000; most remaining accredited
  four-year colleges; major parks…; the most prominent local companies and
  institutions; …the most significant historical, cultural, musical or artistic
  figures and movements."
- **Mid** — "the remaining cities and towns; recognized neighborhoods of San
  Francisco; special districts; community colleges; school districts; …significant
  Census Designated Places; …most biographies of important SFBA historical,
  cultural, and scientific figures."
- **Low** — "most high schools; most buildings; most neighborhoods outside of San
  Francisco; …minor geographic features…; most companies, organizations, and
  structures; biographies of less well-known SFBA people, **and all the biographies
  of people or bands originally from the SFBA that are not well connected to it**."

Two things matter here:

1. The **bolded Low clause is the demote rationale already written as policy.** It
   is close to a plain-English statement of what a connectedness metric measures.
2. The page's **preamble defines importance as reader demand** — "the probability
   of the *average* reader of Wikipedia needing to look up the topic" — which is
   pageviews. This conflicts with Wikidemo's own third rating question ("how
   important is knowing this subject to an overall, comprehensive, balanced
   understanding of the BA"). The two definitions give opposite answers for e.g.
   the Zodiac Killer. **This is unresolved and is a question for the task force,
   not a measurement problem.**

Dorothea Lange is listed on that page as a **Mid** example. She is currently rated
High.

### 2.2 There is no precedent for a bot changing importance ratings

Searches across the whole `Wikipedia:Bots/Requests for approval` namespace:

| Search | Hits |
|---|---|
| `insource:"existing importance"` | 0 |
| `insource:"change the importance"` | 0 |
| `insource:"downgrade" insource:"importance"` | 0 |
| `insource:/re-?assess/ insource:"importance"` | 1 (class-only; **denied**) |

What *has* been approved:

- **Theo's Little Bot 6** (2013) — added `|importance=low` to WikiProject Classical
  Greece and Rome by flat title patterns. Approved quickly: "Very simple bot task,
  sane bot-op." Note it only *filled blanks* and only assigned the floor value.
- **BU RoBOT 15** (2016) — auto-assessed *class* from sibling banners. Approved with
  a staged throttle (2,500 → hold → 5,000 → hold → 10,000 → hold) and a reviewer
  condition to mark auto-assessed edits.

What was objected to:

- **BHGbot** — opposition even to leaving importance *blank*, on the grounds that
  auto-ratings degrade human assessments and destroy the Unassessed queue.

### 2.3 The Unassessed queue is not worked

The BHGbot objection assumes someone processes `Category:Unknown-importance San
Francisco Bay Area articles` (2,598 articles). Measured: of a 200-article sample,
**174 were last edited by a single editor (Jevansen), 170 of them in November 2025**
with the summary `add to WikiProject/s`. It is sediment from one mass-tagging run,
not a worklist.

Caveat: `categorymembers` returns in sortkey order, so this is the first 200
alphabetically, not a random sample. Redo with a random draw before citing on-wiki.

### 2.4 The task force is slow but alive

`WT:WikiProject California/San Francisco Bay Area task force`: 26 edits in 2026,
37 in 2025, 33 in 2024. The "Data-assisted importance review" thread (22 July 2026)
drew two substantive replies within 25 minutes. It is a viable venue; it is not a
venue that will manually review 300 demotions.

`Wikipedia:WikiProject San Francisco` and `…San Francisco Bay Area` both redirect
here. There is no separate Bay Area project.

### 2.5 The Oregon distribution is not a precedent

WikiProject Oregon's 55/30/15/1 target is sometimes cited. It was invented by one
editor in 2007, who said so himself in the same thread: *"since I just sort of threw
out some numbers to begin with its OK to change."* Do not cite it as authority.

---

## 3. The validation method

The central methodological move: **the 11,778 existing human importance ratings are
a labelled calibration set.** Any proposed metric can be scored against them before
it touches a talk page.

Two measures used throughout:

- **Correlation with human tier** — Pearson r against `low=0, mid=1, high=2, top=3`.
- **Incremental R²** — does adding metric X to a model improve prediction of human
  tier *beyond* what's already there? This is the decisive test; standalone
  correlation is misleading when metrics are collinear.

### 3.1 What the corpus is and isn't good for

**Legitimate uses:**

- *Rejecting* metrics — a negatively-correlated metric is disqualified regardless of
  how appealing its rationale.
- *Detecting class-level bias* — e.g. stations scoring 25 points above cohort median
  against a corpus that rates them ~99% Mid-or-below.
- *Bounding claims* — don't assert precision the labels can't distinguish.

**Illegitimate use:** maximising agreement. The corpus contains Netflix at High,
Steven Weinberg at High, and Dorothea Lange at High against her own Mid example in
the criteria. **Optimising to predict these labels would reproduce the errors the
project wants fixed.**

### 3.2 The selection effect (important)

The corpus consists of articles humans *already tagged as Bay Area*. Relevance is
therefore near-constant within it. A metric that measures relevance has almost no
variance to explain and will appear worthless — see §7. This trap was fallen into
during the analysis and the conclusion had to be reversed.

---

## 4. Measurement bugs found and fixed

These fixes account for essentially all the improvement. No new metric helped.
Three separate bugs turned out to be the same bug, which is worth naming before
listing them.

### 4.0 The pattern: not every link is an editorial claim

**A wikilink is not a unit of significance. It is a unit of whatever caused
someone — or something — to write two brackets.**

The metric is trying to measure one specific thing: *an editor decided these two
subjects are related enough to connect*. That is an editorial assertion, and
counting those assertions is a decent proxy for how central a subject is.

But the link table contains four different kinds of thing, and only one of them is
that assertion:

| Kind of link | Why it exists | Evidence of significance? |
|---|---|---|
| **Editorial** | an editor connected two related subjects | **yes — this is the signal** |
| **Structural** | a navbox or template lists every member of a set | no |
| **Bibliographic** | a citation names its source publication | no |
| **Nominal** | the same editorial link written under a different title | yes, but invisible unless resolved |
| **Specification** | an infobox field enumerates values | **mixed — see §4.4, not yet fixed** |

The first three bugs below are one row each; the fourth is found, measured, and
deliberately left in place.

- **Navbox links** are structural. Every BART station links every other BART
  station because they share a template, not because anyone judged them related.
  **77% of all raw links.**
- **Citation links** are bibliographic. `{{cite web |work=[[TechCrunch]]}}` says an
  article *used* TechCrunch as a source, not that it is *about* TechCrunch.
  **~93% of TechCrunch's inbound links.**
- **Redirects** are nominal. `[[California Gold Rush]]` and
  `[[California gold rush]]` are the same editorial act recorded under two names.
  **14% of edges were being dropped.**

They were found in that order, weeks apart, each after the previous fix made the
next one visible. That is the useful lesson: fixing one exposes the next, because
each was hiding inside the noise of the one before.

**The diagnostic to apply to any link-derived metric**, before trusting it: *what
would make this number large for a reason that has nothing to do with importance?*
For raw inlinks the answers were "belonging to a large template family", "being a
frequently-cited publication", and "having only one name". All three were
measurable in minutes and none was visible in the aggregate correlation, which
moved only from 0.367 to 0.520 across all three fixes while individual articles
moved by a factor of five.

This also predicted where the next one would be, and the prediction held: infobox
parameters, listed here as an untested candidate, turned out to be real (§4.4).
Succession boxes, coordinate templates, and `{{main}}`/`{{see also}}` hatnotes
remain candidates and remain unmeasured.

### 4.1 Navbox links were being counted (fixed)

**Found by:** Pi.1415926535 on the task force talk page, 22 July 2026, asking
whether inlink counts included navbox links like `{{Redwood City, California}}`.

**Cause:** `stageLinks` used `prop=links`, which reads the `pagelinks` table — the
*rendered* link set, including every link a transcluded navbox emits. There is no
API flag to exclude them.

**Scale:** measured on live articles, template-generated share of all links:

| Article type | template-generated |
|---|---|
| Pittsburg Center station | 97% |
| Rockridge station | 92% |
| Port of Oakland | 95% |
| Netflix | 77% |
| Jerry Garcia | 63% |
| Craigslist | 45% |

Not uniform — it inflates hardest for exactly one class of article. Cohort-wide,
**570,370 raw edges collapse to 132,317 prose edges: 77% were template-generated.**

**Fix:** new stage crawling raw wikitext (`prop=revisions&rvslots=main`) and
extracting only literal `[[…]]` links (`wikitextLinks()` in `scripts/reassess.js`).

**Effect:** correlation with human tier **0.367 → 0.506**. Transit stations in the
top-60 promote list dropped from **22/60 to 5/60**.

### 4.2 Redirects were not resolved (fixed)

**Found by:** investigating why the Assassinations of George Moscone and Harvey Milk
— a Top-rated article — showed 7 inlinks, while the API reported 332 backlinks.

**Cause:** `wikitextLinks()` returns literal link targets. An article linking
`[[Moscone-Milk assassinations]]` (one of 11 redirects) counted as zero.

**Why it matters — redirect count scales with importance** (n=15 per tier):

| Tier | mean redirects | % with ≥1 |
|---|---|---|
| top | 16.80 | 100% |
| high | 18.33 | 100% |
| mid | 6.20 | 80% |
| low | 1.00 | 53% |

So the metric undercounted inlinks *in proportion to importance*. This was
initially dismissed as a minor symmetric limitation. That was wrong.

**Scale:** **14.0% of all link edges were being discarded** (25,037 of 178,290).

**Fix:** build a redirect→canonical map for all 30,355 pool articles
(93,019 titles mapped), then aggregate `links-prose-all.json` counts onto canonical
titles. No re-crawl needed.

**Effect on individual articles:**

| Article | before | after |
|---|---|---|
| California gold rush | 63 | **345** |
| Assassinations of Moscone and Milk | 7 | **48** |
| Dot-com bubble | 106 | 140 |
| Netflix | 125 | 125 |
| Golden Gate Bridge | 253 | 253 |
| Steven Weinberg | 1 | 1 |
| Hughes Entertainment | 0 | 0 |

The Gold Rush was the analysis's hardest case — it appeared to be a genuinely
important topic the metric couldn't see. It goes from *below* Netflix to nearly 3×
Netflix. Most of the gain is `[[California Gold Rush]]` (title case) being a
redirect. **The metric was right; the measurement was broken.**

Note that articles we were confident about (Hughes Entertainment 0, Steven Weinberg
1) don't move — the correction is targeted, not indiscriminate.

**Effect:** correlation **0.506 → 0.520**. Demote candidates that peers rate
important: **8/60 → 6/60**.

### 4.3 Citation links were being counted (fixed)

**Found by:** reading the proposed Top tier after the first full run. Six of the 46
articles were media outlets — SF Chronicle, The Mercury News, SF Examiner,
TechCrunch, Wired, Oakland Tribune — which is not what the criteria describe as
"core or key topics".

**Cause:** citation templates wikilink the publication they cite.
`{{cite web |work=[[TechCrunch]]}}` is a literal `[[…]]` in the wikitext, so the
extractor counted every footnote as an editorial claim that the citing article is
related to TechCrunch.

**Scale**, measured on articles citing TechCrunch:

| Citing article | `[[TechCrunch` links | inside a citation |
|---|---|---|
| Instagram | 61 | **57** |
| Reddit | 9 | **7** |
| Pinterest | 4 | **3** |

~93%. On Instagram, stripping references removed 52 of 353 links (15%), and the
removed set was ZDNet, AOL, Business Insider, Adweek, Forbes, Reuters, CNNMoney,
Engadget, VentureBeat, The Daily Telegraph, NPR — every one a cited source.

**Fix:** strip `<ref>…</ref>` blocks (including named and self-closing forms) and
bare citation templates (`cite *`, `citation`, `refn`, `sfn`, `harv*`) before
extracting links. Deliberately surgical: a publication linked in genuine prose is
still counted, and there is a test asserting exactly that. TechCrunch survives on
Instagram via its ~4 real prose mentions.

**Effect:** publications fall out of the top tier. Numbers to be filled in from the
re-run.

**Note for anyone re-deriving this:** the fix requires a full re-crawl, because
`links-prose-all.json` stores counts rather than wikitext. That is the second time
discarding intermediate data has cost a crawl (see §11 on `links-prose.json`).
Storing the raw wikitext, or at least per-source edge lists, would make future link
taxonomy questions answerable without re-fetching 18,000 articles.

### 4.4 Infobox specification links — FOUND, PARTLY MEASURED, NOT FIXED

**Found by:** reading the proposed Top tier after the citation fix.
*Android (operating system)* sat at rank 56 with 261 links, which is not a
plausible Bay Area topic ranking.

**Cause:** infobox fields enumerate values as wikilinks, and those links live in
the *article's* wikitext, so they survive every filter above:

```
Google     | products = {{Ubl | [[Google Search]] | [[Android (operating system)|Android]] | [[Google Nest|Nest]]
Instagram  | operating system = {{hlist|[[iOS]]|[[iPadOS]]|[[Android (operating system)|Android]]|[[Fire OS]]
```

Both articles also link Android in genuine prose ("it is available on iOS,
Android"), so the category is **mixed**, unlike navbox and citation links.

**Why it is not simply stripped.** Infobox links are heterogeneous in a way the
other three are not:

| Infobox field | Editorial relation? |
|---|---|
| `location = [[Oakland]]` | **yes** — precisely the claim the metric wants |
| `headquarters = [[San Jose]]` | **yes** |
| `operating system = {{hlist\|[[iOS]]\|[[Android]]}}` | no — a specification list |
| `products = {{Ubl\|[[Google Search]]\|[[Android]]}}` | no |

Stripping all infobox links would discard `location`/`headquarters`, which are
among the strongest signals available. The distinguishing feature of the unwanted
ones is that they are **list templates inside infoboxes** — `{{hlist}}`, `{{Ubl}}`,
`{{plainlist}}`, `{{flatlist}}` — which is a surgical target, but was not
implemented.

**Why it was left in.** Fixing it requires a third full re-crawl (~25 min plus API
load), and the impact is confined to technology-product articles: it does not move
the tier structure, the churn figures, or any §2 evidence. Android is the only
visible case in the top 68. The better sequencing is to migrate to wikitext dumps
first (§4.5), after which this becomes a local re-parse rather than another crawl.

**Do not present the ranking as free of this.** Any published version should say
that infobox specification links are still counted, and that technology products
are therefore somewhat over-ranked.

**What is actually measured, and what is not.** Confirmed: infobox specification
fields do emit wikilinks that survive every filter, with `{{Ubl}}` and `{{hlist}}`
in Google's `products` and Instagram's `operating system`. NOT measured: how much
this inflates any article's total. Checked against a proper parser (below), both
Google and Instagram *also* link Android in genuine prose, so the infobox link is
additional rather than the source of the count. Android's rank may be largely
legitimate. Establishing the real inflation needs a cohort-wide comparison that
has not been run.

**Method note on the false negative.** The first detection attempt reported zero
infobox links and was wrong. It looked backwards for the nearest `{{` and tested
whether it was an infobox — but the nearest opening brace is `{{Ubl` or `{{hlist`,
not `{{Infobox`, so nested templates defeated it. Brace-matching heuristics on
wikitext are fragile.

**The right fix is a real parser, not better regexes.** `wtf_wikipedia`
(npm, v10.4.2, 2026-05-27, actively maintained) parses wikitext structurally and
exposes exactly the taxonomy this section is about:

| Accessor | Gives |
|---|---|
| `doc.links()` | all links — **already excludes `<ref>` content**, so §4.3 is native |
| `doc.sentences().links()` | prose only — excludes infobox spec fields |
| `doc.infoboxes()` | structured field access, so `location`/`headquarters` can be kept while `operating system` is dropped |
| `doc.references()` | citations, separately |

Verified on live wikitext:

| Article | this repo's regexes | `wtf.links()` | `wtf` prose only |
|---|---|---|---|
| Instagram | 301 | 271 | 253 |
| Google | 575 | 549 | 464 |
| Rockridge station | 18 | 15 | 12 |

`wtf` finds ~10% fewer links than the hand-rolled version even before the prose
filter, which means this repo's regexes over-count something not yet identified —
another reason to stop maintaining them.

**Recommendation:** adopt `wtf_wikipedia` as part of the dump migration (LUI-95),
replacing the navbox/citation/infobox stripping in `wikitextLinks()` with
structural extraction. Note the `wikimedia-api` skill's library table lists `mwn`
for API access and `wikibase-sdk` for Wikidata but no wikitext parser; that gap is
worth closing there too.

### 4.5 Why WMF's published link data does not solve this

Checked 2026-07-31, since "get it from the dumps" is the obvious response to three
crawls.

| Source | Distinguishes link kinds? | Currency | Size |
|---|---|---|---|
| `pagelinks` dump / Toolforge replica | **no** — rendered links, undifferentiated | current | small |
| Enterprise **HTML** dumps | **yes** — DOM classes make it explicit | **last run 2025-03-20** | 140 GB |
| `pages-articles` **wikitext** dumps | yes, via the same parsing done here | monthly, current | ~22 GB, chunked |
| REST per-article HTML | yes | live | still a per-article crawl |

`pagelinks` is exactly the rendered link set these three fixes strip down — by the
time a link is a row in that table, the distinction is gone. Enterprise HTML would
have made the whole taxonomy trivial, and stopped being produced in March 2025.

The wikitext dumps do not avoid the parsing, but they make it **local and
repeatable**: every future taxonomy question becomes a re-parse of a file already
on disk instead of another 18,474-article crawl. That is the argument for the
migration, not raw speed. Tracked as LUI-95.

---

## 5. Metric evaluation

### 5.1 Headline results

Correlation with human tier, full cohort, n = 11,778:

| Predictor | r |
|---|---|
| **canonical inlinks** (navbox-stripped, redirects resolved) | **0.520** |
| prose inlinks (navbox-stripped only) | 0.506 |
| raw inlinks (as originally implemented) | 0.367 |
| four-metric composite, navbox-free | 0.282 |
| four-metric composite, as originally shipped | 0.252 |
| `entangle` | 0.175 |
| `lead` | 0.134 |
| `exclusive` | **−0.082** |

Median canonical inlinks by tier: **top 203 · high 32 · mid 10 · low 2**.

### 5.2 The composite was worse than its own best ingredient

Incremental R² (n = 11,778, measured pre-redirect-fix):

| Model | R² |
|---|---|
| inlinks alone | 0.2563 |
| inlinks + entangle | 0.2569 |
| inlinks + lead | 0.2563 |
| inlinks + entangle + lead | 0.2569 |

**`lead` adds +0.0000. `entangle` adds +0.0006.**

The median-of-four-percentiles design was chosen so no single metric could promote
or demote alone. That robustness cost roughly half the predictive power: r = 0.282
for the composite against r = 0.520 for its best component.

**Caveat:** this is measured *within the tagged cohort*. See §7 — it does not mean
`lead` is useless.

---

## 6. Rejected ideas

Recorded so they are not rebuilt. Each was implemented and measured.

### 6.1 `exclusive` — 1/(1 + other WikiProjects) — DROPPED

**Rationale:** an article only SFBA cares about is more Bay-Area-defining than one
where we're the tenth banner.

**Result:** r = **−0.082**. Backwards. Mean count of other WikiProjects by tier:
top 4.90, **high 6.31**, mid 5.33, low 4.90. Important topics *attract* projects.
Non-monotone — it flips to +0.117 *within* the Top/High band, meaning it measures
different things in different parts of the range.

Four rescue attempts, all failed:

| Variant | Result |
|---|---|
| ratio as originally built | r = −0.082 |
| 10+/15+ banner threshold | monotone *increasing* with importance (0–2 banners → 15% Mid+; 15+ → 40% Mid+) |
| inlink ratio (SF/total), raw or prose | r ≈ 0.08, dominated by plain inlinks at 0.341 |
| peer-importance comparison | inverted (below) |

**The peer comparison is worth recording in detail** because it seemed like the
right idea. Comparing SFBA's rating to other projects' ratings of the same article:

- The 60 demote candidates are rated **higher** by peers (mean 2.08) than the
  Top/High articles we keep (1.96).
- 220 of 479 Top/High articles are ones only SFBA rates highly — but those are
  Palo Alto, Alameda, San Francisco Peninsula, Mission San Francisco de Asís.
  **A local project rating local topics above global projects is correct
  behaviour, not inflation.** The signal cannot separate "correctly parochial"
  from "courtesy tag."
- Netflix: peer mean 2.27, max 4. Google 3.40. YouTube 3.08. These are not cases of
  SFBA inflating something nobody else cares about.

### 6.2 Editor-count metric (prior session, 2026-07-23) — REJECTED

Three variants (crowd size, crowd purity, edit concentration) built, run cohort-wide,
backed out. Crowd size correlates r = 0.960 with raw editor count (a fame proxy);
crowd purity floods promote with 47/60 transit stations. Full numbers in
`../sfedits-notes/IDEAS.md` under "Loose ends". Crawl output survives at
`data/reassess/editors.json` (18MB, inert).

Note: that rejection was decided by eyeballing churn in the top/bottom 60. The
incremental-R² test now available would have settled it in seconds.

### 6.3 Class floor rules — REJECTED (redundant)

**Rationale:** derive rules from high-purity classes ("basketball seasons are 98%
Low") and apply them as guardrails.

**Result:** the metric already handles them. Floor-class articles appearing among
promote candidates: 2/60 by composite, **0/60 by prose inlinks**. 1,229 floor-class
articles in the cohort would be touched to change the outcome for ~5.

**Why the idea was wrong:** it was derived from class *purity*, which measures
predictability, not error. High predictability is exactly when a rule is redundant.
The navbox fix had already removed the underlying problem at source.

**Also, one rule was actively wrong:** baseball team seasons look like basketball
and football seasons but are **40% Mid or above** (1972/1973/1990 Oakland Athletics,
1971 San Francisco Giants). Writing that rule by analogy would have demoted ~50
articles the project deliberately rated up.

### 6.4 Lead-section inlinks — REJECTED (redundant)

**Rationale:** leads carry constitutive facts, so "is this mentioned in another
article's lead?" should distinguish defining topics from incidentally-connected
ones.

**Result:** r = 0.503 with human tier but **r = 0.836 with prose inlinks** — the
same measurement with more steps. And it fails the case it was built for:
**Netflix 27 lead-inlinks, California gold rush 18.** Being lead-worthy to some
article isn't being constitutive of the region.

### 6.5 Pageviews as a fifth metric — REJECTED as a predictor

Measured on 5,267 rated articles with canonical inlinks:

| Model | R² |
|---|---|
| inlinks alone | 0.3202 |
| pageviews alone | 0.0549 |
| inlinks + pageviews | 0.3262 |

**+0.0060.** An earlier measurement showed +0.049, but that was against the weak
four-metric composite — pageviews looked orthogonal only because what they were
added to was bad.

**But this is a values question, not just a statistic.** The project's ratings track
connectedness, not readership, even though its own criteria preamble defines
importance as reader demand. Adding pageviews wouldn't improve agreement with past
practice; it would *change the standard*. That may be defensible — see the crime
articles in §9.2 — but it should be proposed to the task force explicitly, not
smuggled in as a weighting.

Partial-crawl caveat: 5,267 of 11,778 rated articles, in pool order rather than
random, tier proportions roughly representative. Crawl was stopped once the
question was answered; 7,600 entries retained.

### 6.6 `entangle` abstention placeholder — MOOT

**Rationale:** articles with no location property (events, movements) score 0 on
`entangle` for structural reasons, not because they're unconnected. Abstain instead
— take median of the remaining metrics.

**Built and measured:** loose definition abstains for 14.6% of articles, gains
+4.2 percentile points on average, cuts suspect demotes 14 → 10. Abstainers still
average well below everyone else (40.8 vs 51.8) and Hughes Entertainment *falls*
(12.4 → 9.9), so it corrects a penalty rather than granting promotion.

**Why moot:** `entangle` contributes +0.0006 overall (§5.2). Fixing its blind spot
changes nothing. This was built before running the incremental test that would have
shown it was pointless.

Also note the diagnosis was partly wrong: California gold rush and Dot-com bubble
*do* have location properties — their zeros are genuine. `entangle` measures "is it
*located in* the Bay Area", not "is it *significant to* the Bay Area." The Gold Rush
happened in the Sierra foothills and *caused* San Francisco.

### 6.7 Top/High inlink-ratio refinement — DROPPED

The existing `significanceTH` swaps raw inlink percentile for inlink-*ratio*
percentile within Top/High. Intended to stop famous articles hiding behind link
volume.

**Result:** it is the single largest source of bad demotes. Demote candidates peers
rate important: **14/60 with the refinement, 12/60 without, 9/60 by prose inlinks
alone.** It over-corrects, penalising articles that have both strong Bay Area link
presence *and* global fame — which is what a genuinely important Bay Area topic
looks like.

### 6.8 Per-class calibration — PROPOSED, NOT VALIDATED

Subtract each Wikidata class's measured residual (metric percentile minus human
percentile) from its members' scores. Learned from the corpus rather than
hand-written.

**Status: not adopted.** Three unresolved problems:

1. **It must be redone against the corrected metric.** The residuals computed
   during analysis used the pre-redirect-fix score and a different baseline
   (composite vs inlink-only), so the published tables are not comparable.
2. **It is blind to small classes.** The n≥30 threshold excludes the crime cluster
   entirely — largest crime class is "murder" at n=16 — which is where the metric
   fails worst (§9.2).
3. **Every calibration needs a plain-language mechanism**, not just a residual.
   Requirement set by the project owner: a calibration you can't explain is
   overfitting with extra steps.

Mechanisms established so far, which would survive that bar:

| Class | Direction | Mechanism |
|---|---|---|
| rail/metro/tram stations | overrated | A station's identity *is* its location, so Wikidata records it densely (median **7** Bay Area statements vs ~1 typical) and its lead names its city in the opening clause. Both metrics reward location-specificity, which stations max out by definition. |
| sports team seasons | overrated | The place name is inside the team name, so `lead` fires for **97%** of them. It matches the title, not the significance. |
| wine regions (AVAs) | overrated | Every winery links to its AVA (median **19** inlinks), so the count tracks how thoroughly Wikipedia covers local wineries. |
| newspapers, radio | overrated | Linked from the Media section of every town in the coverage area — market footprint, not importance. |
| roads, streams, neighborhoods, unincorporated communities | overrated | Linear and administrative geography is exhaustively cross-referenced by convention. |
| literary works, albums | underrated | All instruments silent: 27% have no location property, **44%** score zero on lead, median **1** inlink. |
| taxa | underrated | **100%** have no location property — a species has a range, not an address. |
| biographies | underrated | **45%** score zero on lead because bios open with nationality and occupation, not place. |

Two classes were deliberately **left uncalibrated** because no mechanism was found:
*island* (−16.9) and *rancho of California* (−10.0). Islands are places and ought to
score well; the residual may be genuine importance (Alcatraz, Angel Island) rather
than bias.

**The general statement, suitable for a talk page:** *the score measures how
locatable a subject is, not how significant it is — so it favours subjects whose
identity is their location and penalises subjects that have no address at all.*

### 6.9 Wikidata taxonomy as a rating scheme — REJECTED

Predicting tier from Wikidata class:

| Strategy | Accuracy |
|---|---|
| Always guess "Low" | 79.2% |
| Class-modal tier (covers 76% of articles) | **81.2%** |

Two points. The 2007 criteria are largely a taxonomy of thing-types, and thing-type
barely predicts what the project did.

Separately, mapping the criteria's *explicit* clauses onto `P31` decides only
**1,087 articles (7.5%)**, while **50%** falls into blocks the criteria can't decide
mechanically (4,364 humans, 981 companies, 933 sports seasons, 403 nonprofits,
295 creative works, 269 bands). Caveat: 7.5% is a floor — exact P31 matching against
~20 named classes, no `P279*` subclass traversal. Proper traversal would score
higher; unmeasured.

---

## 7. The selection effect, and the correction

**A conclusion in this analysis was reversed and the reversal matters.**

Every metric was evaluated against "predicts human tier within the tagged cohort."
On that test `lead` contributes +0.0000 and was recommended for removal.

That test is blind to relevance, because **the tagged cohort has already been
filtered for Bay Area relevance by humans.** Relevance is near-constant, so a
relevance metric has no variance to explain.

Applied to the *unfiltered* pool, ranking by canonical inlinks alone surfaces:

| Untagged article | inlinks | entangle | lead |
|---|---|---|---|
| University of California, Davis | 219 | 3 | **0.00** |
| Internet Archive | 190 | 3 | **0.00** |
| Microsoft | 177 | 1 | **0.00** |
| Ronald Reagan | 142 | 1 | **0.00** |
| Sierra Club | 101 | 1 | 0.86 "San Francisco" |
| Port of Oakland | 69 | 5 | 0.98 "Oakland" |

Microsoft is in Redmond. UC Davis is in Yolo County. These are not Bay Area topics —
they are topics Bay Area articles *mention a lot*. **`lead` is the thing that keeps
them out**, despite contributing nothing inside the cohort.

So the correct architecture is two-stage (§1.1). This also explains why the original
four-metric design existed: the metrics were doing different jobs, and a single
"predicts human tier" test could only ever see one of them.

**This does not rehabilitate `exclusive`** — it was negatively correlated *and*
doesn't separate the intruders (Microsoft `entangle`=1, same as Netflix).

### 7.1 Known weakness of the relevance gate

`lead` substantially detects *"a Bay Area place name appears early"*: mean lead score
is **0.914** for articles whose title contains a Bay Area term versus **0.458**
otherwise (r = 0.458 between the two). It will admit anything with a place name in
its title and reject genuinely-Bay-Area topics that don't name a place up front.

For a watchlist this asymmetry is tolerable — a false positive costs one dull post,
a false negative costs silence. **It should not be presented on-wiki as a measure of
relevance.**

Gate variants measured on the 29,935 pool:

| Gate | passes | notes |
|---|---|---|
| `lead > 0` | 16,681 | cleaner; filters Microsoft, Ronald Reagan |
| `lead > 0 OR entangle ≥ 2` | 20,165 | leaky — admits UC Davis via the entangle arm |

(Internet Archive passes and *should* — it is headquartered in San Francisco's
Richmond District and is a genuine tagging gap.)

---

## 8. Conclusions

### 8.1 Final scoring architecture

```
relevance gate:   lead > 0                    (is it about the Bay Area?)
importance rank:  log(canonical inlinks)      (how central is it?)

canonical inlinks = cohort-internal links, navbox/template links excluded,
                    redirects resolved to canonical titles
```

Dropped: `exclusive` (harmful), the Top/High ratio refinement (harmful),
`entangle` and `lead` *as ranking metrics* (≈0 incremental — but `lead` retained as
the gate).

Not adopted: pageviews, class calibration, floor rules, lead-inlinks, peer
comparison, editor counts.

### 8.2 What actually produced the improvement

| Change | effect on r |
|---|---|
| Strip navbox/template links | 0.367 → 0.506 |
| Resolve redirects | 0.506 → **0.520** |
| Composite → single metric | 0.282 → 0.520 |

**Two measurement fixes roughly doubled agreement with human judgement. Four
metrics and a ratio refinement contributed nothing or worse.** No new signal was
found that helped; every additive idea tested was redundant, harmful, or moot.

### 8.3 Watchlist sizing (measured)

Edits per day for a score-ranked, gated watchlist (n=25 sampled per band; the
non-monotonic 500–1000 figure is sampling noise):

| Rank band | edits/article/30d | cumulative edits/day |
|---|---|---|
| top 100 | 3.04 | ~10 |
| 100–500 | 1.48 | ~30 |
| 500–1000 | 2.04 | ~64 |
| 1000–2500 | 0.88 | ~108 |

Consistent with the earlier estimate in `../sfedits-notes/SFBA-TAGGING-EDITS.md`
(~2,450 articles ≈ 50–120 edits/day). Suggests ~500 for a Bluesky/Mastodon account
and ~2,500 for a Discord-only account — which is the two-account split already
contemplated in the config.

### 8.4 The decoupling result

The bot currently filters on `importance IN [Top, High]`, so improving its coverage
requires winning consensus on hundreds of talk-page edits. **Ranking by score
instead decouples the bot from the on-wiki rating process entirely.** Daniel Lurie
gets watched because he ranks; Netflix drops off because it doesn't; The Mercury
News (currently Mid, 761 inlinks — 10th in the whole pool) gets watched today;
Internet Archive gets watched despite never having been tagged.

Reassessment then becomes a *contribution to Wikipedia* rather than a *prerequisite
for the bot*.

**Open design question:** where this logic should live. Encoding SFBA-specific
policy in the bot conflicts with the goal of genericising it for other regions and
projects (see `docs/design-plans/2026-07-23-place-bot-platform.md`). Not resolved.

---

## 9. Open questions

### 9.1 Zero-inlink articles: unimportant, or orphaned?

The corrected demote head contains articles with 0–1 canonical inlinks that *sound*
important:

```
0  high  Politics in the San Francisco Bay Area
0  high  San Francisco in the 1970s
0  top   History of San Francisco State University
1  top   Oakland Seaport
1  high  Mayoralty of Gavin Newsom
```

The Moscone/Milk case showed a low count can mean **the encyclopedia is
under-linked**, not that the topic is unimportant. Each of these should be checked
against real backlink counts before demotion. Distinct problems, distinct fixes.

### 9.2 Crime articles are systematically underrated — and calibration misses them

38 Wikidata-classified crime articles: **median 1 canonical inlink, median
significance 36.7** against a cohort median of 49.9. The "murder" class (n=16) has
median **646,488 annual pageviews** against median 1 inlink.

Crimes are read heavily and linked rarely. They are also where the criteria's two
definitions of importance (§2.1) conflict most sharply: reader demand says the
Zodiac Killer (2.2M views/yr) is Top; "comprehensive understanding of the Bay Area"
says otherwise. **Task force decision, not a measurement.**

The n≥30 calibration threshold cannot see this class at all.

### 9.3 The link-gap output may be more valuable than reassessment

For the Assassinations of Moscone and Milk: **332 articles link it, 218 mention it
textually, 122 mention it without linking.** The unlinked include Jonestown, Jim
Jones, Peoples Temple in San Francisco, Government of San Francisco, and Golden
Dragon massacre — all of which plainly should link it.

Adding links is uncontroversial, needs no consensus, unambiguously improves the
encyclopedia, and *directly improves the signal the ranking depends on*. It also
scales with a bot in a way rating changes do not.

### 9.4 Untagged pool noise

The 15,541 untagged candidates are noisy by the generating script's own assessment
(`IDEAS.md` §3 rejected the pull as a watchlist source). As a tagging-candidate
list, "noise means a human skims past" — which stops being true at 15k rows with a
bot. The relevance gate helps but does not eliminate this.

### 9.5 Split/rename detection — TODO, not yet run

A Top/High article with near-zero **canonical** inlinks but a high **total**
backlink count is the signature of something structural happening on-wiki — a
rename, split, or content fork — not of an unimportant topic.

Worked example found on 2026-07-30: **Oakland Seaport** (Top, Start-class, 1
canonical prose inlink, 500 total backlinks). Not orphaned by neglect. In June 2024
an editor correctly split the port *authority* out of the *facility* article,
creating **Port of Oakland** (2024-06-29). Editors write `[[Port of Oakland]]`, so
inbound links now resolve to the new article — which carries **no SFBA assessment at
all** and ranked 4th in the untagged report at 99.1 significance. The task force is
rating the wrong article, and some fraction of the 304 backlinks to the new article
were written pre-split meaning the facility, so they are probably mis-targeted.

**To do:** sweep the cohort for `canonical inlinks ≈ 0 AND total backlinks high`.
Cheap — runs against `inlinks-canonical.json` plus a `list=backlinks` pass. Would
show whether Oakland Seaport is a one-off or the cohort has systematic staleness
from renames and splits.

**Why it matters for framing:** "this should be demoted" and "this article was
orphaned by a split" are very different messages to a task force, and the second is
far easier to act on. Any demote list should separate them.

### 9.6 Full-pool ranking not yet produced

The 29,935-article ranking with the corrected metric has not been generated as a
deliverable. Earlier full-pool modelling used the uncorrected metric and its
conclusions (e.g. "73% of Top/High would be demoted") are **superseded** and should
not be cited.

---

## 10. Process notes

Recorded because they cost real time:

- **Twice, substantial machinery was built on an unmeasured assumption** — the
  entangle abstention rule (moot once incremental R² was run) and the class floor
  rules (redundant once tested against actual promote candidates). In both cases the
  measurement that would have prevented the work took under five minutes. **Run the
  incremental test before building.**
- **Five of the ideas tested were negative results.** That is the calibration set
  doing its job — it is cheap to kill ideas against 11,778 labels before they reach
  a talk page.
- **`insource:"[[Foo"` does not match literally.** CirrusSearch strips `[[` as
  punctuation, so it matches the phrase anywhere, including inside `{{Main|Foo}}`.
  Use `insource:/\[\[Foo[|\]#]/`. A false alarm from this sent the analysis looking
  for a parser bug that didn't exist.
- **The pageviews API rate-limits aggressively.** ~103 articles at 8-way concurrency
  with no delay produced a truncated, tier-skewed sample that was nearly reported
  before the skew was noticed. Serial with 120ms and 429-backoff is reliable.
- **Stratified samples inflate absolute correlations.** Comparisons between
  predictors on the same sample remain valid; absolute values do not transfer to the
  population.

---

## 11. Data provenance

Analysis artifacts preserved in `data/reassess/analysis/` (gitignored, like all of
`data/`):

| File | Contents | How produced |
|---|---|---|
| `inlinks-canonical.json` | canonical inlink counts — **the metric** | remap of `links-prose-all.json` through `redirmap.json` |
| `redirmap.json` | 93,019 titles → canonical target | `prop=redirects` over the 30,355-article pool |
| `p31.json` | Wikidata `P31` per item (14,441) | `wbgetentities` |
| `props.json` | location-property presence per item | `wbgetentities` |
| `labels.json` | en labels for classes with n≥3 (509) | `wbgetentities` |
| `xproj.json` | per-project assessments for the cohort | `prop=pageassessments&pasubprojects=true` |
| `enriched.json` | cohort rows + peer-importance means | derived from `xproj.json` |
| `pvall.json` | annual pageviews (7,600, partial) | REST pageviews API |
| `leadlinks.json` | lead-section inlink counts | wikitext crawl, pre-first-heading |
| `resid.json`, `lift.json` | class residuals and lift | derived |

In `data/reassess/` proper: `links-prose.json` (cohort-internal prose links) and
`links-prose-all.json` (all 274,179 prose link targets — the unfiltered version,
which is what makes the redirect remap possible without re-crawling).

**Design lesson embedded in those two files:** `links-prose.json` filters to cohort
members at crawl time and discards everything else — the same mistake `prop=links`
made at a different level. The moment counts were needed for another target set, the
provenance was gone and the crawl had to be repeated. `links-prose-all.json` exists
because of that, and is why the redirect fix cost minutes instead of an hour.

### 11.1 Code status

**Implemented in `scripts/reassess.js`** (33 reassess tests, suite green at 264):

- `wikitextLinks()` — navbox-free link extraction
- `stageLinksProse` / `stageLinksProseAll` — filtered and unfiltered prose crawls
- `stageRedirects` — redirect → canonical map (new stage, resumable)
- `canonicalInlinks()` — folds redirect counts onto canonical titles
- `scoreCohort` — scores on canonical-inlink percentile when available;
  `exclusive` removed from the metric set; the Top/High ratio refinement
  (`significanceTH`) removed entirely; `entangle`/`lead`/`exclusive`/`ratio`
  retained on the row as reported evidence
- report rewritten with a canonical/raw inlink pair and a method preamble

Falls back to the legacy median-of-metrics score, with a printed warning, when
`links-prose-all` or `redirects` are not cached.

**Not implemented** — these remain analysis-only, pending the decision on where
the code should live:

- the `lead > 0` **relevance gate** (only needed outside the tagged cohort)
- **score-ranked watchlist selection** (top-N instead of a tier filter)
- the **full-pool ranking** across all 29,935 articles
- **class calibration** (see §6.8 — not validated)
- the **link-gap worklist** (§9.3)
