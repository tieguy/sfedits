> **SUPERSEDED — 2026-07-31.** Written before three measurement fixes (citation
> links), the eligibility-rule change, and the complete data re-run. **Every number
> below is stale.** Kept for the reasoning about selection variants and for the
> record of a bug: the first version applied the relevance gate to already-tagged
> articles, which wrongly dropped YouTube, Google and Netflix.
>
> Current numbers: `data/reassess/ranking-report.md` (generated).
> Current framing: [`wikiproject-process-proposal.md`](wikiproject-process-proposal.md).

# Proposal: switch the bot watchlist from Top+High to a top-500 ranking

Status: **draft, not implemented, nothing posted on-wiki**
Prepared: 2026-07-30

The bot currently watches articles the SFBA task force rated Top or High — 506
articles as of today. This replaces that filter with a ranked selection of 500
articles drawn from the full 29,935-article pool (14,394 tagged + 15,541 untagged
Wikidata candidates).

**This is entirely within our control.** The watchlist is the bot operator's choice.
Changing it needs no consensus, breaks nothing for anyone else, and is reversible by
editing one config value. If the resulting coverage prompts discussion on-wiki, that
is a feature — but the change does not depend on anyone agreeing to it.

Methodology and evidence for the ranking metric:
[`importance-ranking-methodology.md`](importance-ranking-methodology.md).

---

## 1. Selection rule

```
Rank by canonical inlink count and take the top 500, from:
  - all tagged articles, regardless of current rating
  - untagged Wikidata candidates that pass the relevance gate (lead > 0)
```

No carve-outs. Existing ratings are used only as *evidence to be reported*, never as
a floor or a guarantee. The point of the exercise is to stop inheriting a rating
system that has not been maintained; re-privileging the old Top list at the last
step would defeat it.

`canonical inlinks` = how many other Bay Area articles link to this one, counting
only links written in an article's own wikitext (navbox and template links
excluded) and folding redirects onto the canonical title. It correlates r = 0.520
with existing human importance ratings — the previous four-metric composite reached
0.282.

**Cutoff: 51 inlinks.**

### 1.1 The relevance gate applies only to untagged articles

`lead > 0` (a Bay Area term appears in the article's lead) is a proxy for "this
article is about the Bay Area." It is needed for untagged candidates, where ranking
by inlinks alone surfaces Microsoft, UC Davis and Ronald Reagan — articles that Bay
Area pages merely mention often.

It must **not** be applied to already-tagged articles. Someone has already made that
relevance call, and the gate is a weaker proxy for it. Gating the tagged cohort
drops YouTube (438 inlinks), Google (263) and Netflix (125), whose leads open
"American multinational technology company" rather than naming a city. That was a
bug in the first draft of this analysis.

Note this is a relevance judgement, not an importance one — it is the one place the
old tagging is still trusted, and only to answer "is this article in scope at all."

---

## 2. What changes

| | count |
|---|---|
| Current watchlist (Top + High) | 504 |
| Proposed watchlist | 500 |
| **Kept** | **208** |
| **Dropped** | **296** |
| **Added** | **292** |

Dropped by current rating: **278 High, 18 Top**.
Added by current rating:

| Current rating | added |
|---|---|
| Mid | 206 |
| Low | 61 |
| *untagged entirely* | 19 |
| unassessed (Unknown) | 6 |

Only 41% of the current watchlist survives. That is the expected result of replacing
a stale hand-maintained list with a measured one, not a sign of instability.

### 2.1 The churn is concentrated at the boundary

- **Added** articles: 51 / 79 / 761 inlinks (min / median / max).
- **Dropped** articles: 0 / 18 / 50.

36 of the 296 drops sit within 10 inlinks of the cutoff — coin flips where nothing
turns on the outcome. At the other end, **82 drops have fewer than 10 inlinks** and
several have zero.

### 2.2 The 18 Top-rated drops

These are the most contentious rows, so they are listed in full. They split cleanly.

**Near the line (40–49 inlinks)** — arguably just below an arbitrary cutoff:

| Article | Inlinks |
|---|---|
| Point Reyes | 49 |
| Wine Country | 49 |
| Assassinations of George Moscone and Harvey Milk | 48 |
| San Mateo–Hayward Bridge | 47 |
| Alcatraz Federal Penitentiary | 42 |
| Mount Hamilton (California) | 40 |
| Richmond–San Rafael Bridge | 40 |

**Well below the line** — evidence the Top list itself needs work:

| Article | Inlinks |
|---|---|
| October 2017 Northern California wildfires | 23 |
| Eastern span replacement of the SF–Oakland Bay Bridge | 22 |
| List of cities and towns in the San Francisco Bay Area | 22 |
| History of San Francisco | 20 |
| HP Inc. | 15 |
| Jared Huffman | 9 |
| Sports in the San Francisco Bay Area | 7 |
| Transportation in the San Francisco Bay Area | 6 |
| Food First | 3 |
| Oakland Seaport | 1 |
| History of San Francisco State University | 0 |

A Top-importance article with **zero** inbound prose links from any Bay Area article
is not a topic the encyclopedia treats as core. Oakland Seaport is a special case —
its links were captured by a *Port of Oakland* article created in June 2024 (see
methodology §9.5) — but most of this list is simply stale.

### 2.3 Most notable additions

| Article | Current | Inlinks |
|---|---|---|
| The Mercury News | mid | 761 |
| Stanford, California | low | 384 |
| Oakland Tribune | mid | 300 |
| Mission District, San Francisco | mid | 296 |
| San Mateo, California | mid | 275 |
| California Memorial Stadium | mid | 261 |
| Stanford Stadium | low | 243 |
| TechCrunch | low | 240 |
| Facebook | mid | 239 |
| Financial District, San Francisco | mid | 236 |

The Mercury News is the 10th most-linked article in the entire pool, is rated Mid,
and is therefore invisible to the bot today.

### 2.4 Most notable drops

All currently High, all at or just below the cutoff:

| Article | Inlinks |
|---|---|
| Stephen Curry | 50 |
| Las Vegas Raiders | 50 |
| Stanford Law School | 50 |
| California State Route 480 | 50 |
| Cisco | 49 |
| Government of San Francisco | 49 |
| Gap Inc. | 48 |

---

## 3. Caveats

**Some zero-inlink drops may be orphaned rather than unimportant.** A near-zero
canonical inlink count with a high *total* backlink count is the signature of a
rename or split. Oakland Seaport is the worked example (methodology §9.5). Other
such cases are likely sitting in the dropped list unexamined; the sweep to find them
has not been run.

**The relevance gate has a known bias.** It substantially detects "a Bay Area place
name appears early," so it admits anything with a place name in its title and
rejects Bay Area topics that do not name a place up front. For a watchlist this is
tolerable — a false positive costs one dull post, a false negative costs silence.

**19 untagged articles would be watched that no WikiProject has assessed.** They pass
the gate and rank highly but have had no human relevance check. Worth eyeballing.

**Volume is unchanged.** ~30 edits/day for 500 articles, essentially the same as the
current 506. This changes coverage, not posting rate.

---

## 4. Implementation

Not yet built. `scripts/reassess.js` computes the metric but does not emit a
watchlist.

Open question, deliberately unresolved: **where this logic should live.** Encoding
SFBA-specific selection in the bot conflicts with genericising it for other regions
(`docs/design-plans/2026-07-23-place-bot-platform.md`). Options include a
periodically-regenerated static list in config, a generic "rank by inlink centrality
within a tagged set" feature, or keeping selection outside the bot entirely.

The `accounts` array already supports per-account article sets, so a Bluesky account
at 500 and a Discord account at 2,500 is expressible today.

---

## 5. If it comes up on-wiki

The change requires no consensus and no justification. But the diff surfaces two
things worth raising with the task force on their own merits:

1. **The Mercury News, Oakland Tribune and the Mission District are rated Mid** while
   being among the most-linked Bay Area articles in existence.
2. **19 well-linked articles carry no SFBA tag at all**, including at least one
   (Port of Oakland) that appears to be the successor to a Top-rated article.

Both are checkable claims about specific articles that do not require anyone to
accept the ranking methodology.

---

## Appendix A — all 292 additions

| Article | Current rating | Inlinks |
|---|---|---|
| [The Mercury News](https://en.wikipedia.org/wiki/The_Mercury_News) | mid | 761 |
| [Stanford, California](https://en.wikipedia.org/wiki/Stanford%2C_California) | low | 384 |
| [Oakland Tribune](https://en.wikipedia.org/wiki/Oakland_Tribune) | mid | 300 |
| [Mission District, San Francisco](https://en.wikipedia.org/wiki/Mission_District%2C_San_Francisco) | mid | 296 |
| [San Mateo, California](https://en.wikipedia.org/wiki/San_Mateo%2C_California) | mid | 275 |
| [California Memorial Stadium](https://en.wikipedia.org/wiki/California_Memorial_Stadium) | mid | 261 |
| [Stanford Stadium](https://en.wikipedia.org/wiki/Stanford_Stadium) | low | 243 |
| [Big Game (American football)](https://en.wikipedia.org/wiki/Big_Game_(American_football)) | mid | 241 |
| [TechCrunch](https://en.wikipedia.org/wiki/TechCrunch) | low | 240 |
| [Facebook](https://en.wikipedia.org/wiki/Facebook) | mid | 239 |
| [Financial District, San Francisco](https://en.wikipedia.org/wiki/Financial_District%2C_San_Francisco) | mid | 236 |
| [South of Market, San Francisco](https://en.wikipedia.org/wiki/South_of_Market%2C_San_Francisco) | mid | 231 |
| [List of San Francisco Designated Landmarks](https://en.wikipedia.org/wiki/List_of_San_Francisco_Designated_Landmarks) | low | 225 |
| [Bancroft Library](https://en.wikipedia.org/wiki/Bancroft_Library) | mid | 220 |
| [Redwood City, California](https://en.wikipedia.org/wiki/Redwood_City%2C_California) | mid | 219 |
| [Market Street (San Francisco)](https://en.wikipedia.org/wiki/Market_Street_(San_Francisco)) | mid | 214 |
| [CEFCU Stadium](https://en.wikipedia.org/wiki/CEFCU_Stadium) | low | 203 |
| [Ohlone](https://en.wikipedia.org/wiki/Ohlone) | mid | 201 |
| [Oracle Park](https://en.wikipedia.org/wiki/Oracle_Park) | mid | 201 |
| [List of watercourses in the San Francisco Bay Area](https://en.wikipedia.org/wiki/List_of_watercourses_in_the_San_Francisco_Bay_Area) | mid | 199 |
| [Candlestick Park](https://en.wikipedia.org/wiki/Candlestick_Park) | mid | 198 |
| [Menlo Park, California](https://en.wikipedia.org/wiki/Menlo_Park%2C_California) | mid | 197 |
| [Oakland Raiders](https://en.wikipedia.org/wiki/Oakland_Raiders) | low | 190 |
| [KTVU](https://en.wikipedia.org/wiki/KTVU) | mid | 188 |
| [Wired (magazine)](https://en.wikipedia.org/wiki/Wired_(magazine)) | low | 185 |
| [SF Weekly](https://en.wikipedia.org/wiki/SF_Weekly) | low | 184 |
| [San Francisco Police Department](https://en.wikipedia.org/wiki/San_Francisco_Police_Department) | mid | 181 |
| [San Leandro, California](https://en.wikipedia.org/wiki/San_Leandro%2C_California) | mid | 176 |
| [CNET](https://en.wikipedia.org/wiki/CNET) | low | 175 |
| [Golden State Warriors](https://en.wikipedia.org/wiki/Golden_State_Warriors) | mid | 173 |
| [KGO-TV](https://en.wikipedia.org/wiki/KGO-TV) | mid | 173 |
| [Moraga, California](https://en.wikipedia.org/wiki/Moraga%2C_California) | mid | 170 |
| [Valley Transportation Authority](https://en.wikipedia.org/wiki/Valley_Transportation_Authority) | mid | 169 |
| [List of neighborhoods in San Francisco](https://en.wikipedia.org/wiki/List_of_neighborhoods_in_San_Francisco) | mid | 168 |
| [KPIX-TV](https://en.wikipedia.org/wiki/KPIX-TV) | mid | 167 |
| [The Press Democrat](https://en.wikipedia.org/wiki/The_Press_Democrat) | mid | 167 |
| [Los Gatos, California](https://en.wikipedia.org/wiki/Los_Gatos%2C_California) | mid | 165 |
| [NBC Sports Bay Area](https://en.wikipedia.org/wiki/NBC_Sports_Bay_Area) | low | 163 |
| [Castro District, San Francisco](https://en.wikipedia.org/wiki/Castro_District%2C_San_Francisco) | mid | 161 |
| [Kezar Stadium](https://en.wikipedia.org/wiki/Kezar_Stadium) | mid | 161 |
| [Pleasanton, California](https://en.wikipedia.org/wiki/Pleasanton%2C_California) | mid | 158 |
| [Rotten Tomatoes](https://en.wikipedia.org/wiki/Rotten_Tomatoes) | mid | 158 |
| [Yahoo](https://en.wikipedia.org/wiki/Yahoo) | mid | 158 |
| [Embarcadero (San Francisco)](https://en.wikipedia.org/wiki/Embarcadero_(San_Francisco)) | mid | 156 |
| [Mill Valley, California](https://en.wikipedia.org/wiki/Mill_Valley%2C_California) | mid | 148 |
| [Oakland Museum of California](https://en.wikipedia.org/wiki/Oakland_Museum_of_California) | low | 146 |
| [San Francisco Ferry Building](https://en.wikipedia.org/wiki/San_Francisco_Ferry_Building) | mid | 146 |
| [Tenderloin, San Francisco](https://en.wikipedia.org/wiki/Tenderloin%2C_San_Francisco) | mid | 145 |
| [East Bay Times](https://en.wikipedia.org/wiki/East_Bay_Times) | mid | 144 |
| [Oakland Arena](https://en.wikipedia.org/wiki/Oakland_Arena) | mid | 144 |
| [KNTV](https://en.wikipedia.org/wiki/KNTV) | mid | 143 |
| [U.S. Route 101 in California](https://en.wikipedia.org/wiki/U.S._Route_101_in_California) | *untagged* | 142 |
| [Sunset District, San Francisco](https://en.wikipedia.org/wiki/Sunset_District%2C_San_Francisco) | mid | 141 |
| [Livermore, California](https://en.wikipedia.org/wiki/Livermore%2C_California) | mid | 140 |
| [Saint Mary's College of California](https://en.wikipedia.org/wiki/Saint_Mary's_College_of_California) | mid | 138 |
| [California State Route 1](https://en.wikipedia.org/wiki/California_State_Route_1) | *untagged* | 136 |
| [Bay Area Reporter](https://en.wikipedia.org/wiki/Bay_Area_Reporter) | low | 135 |
| [The San Francisco Call](https://en.wikipedia.org/wiki/The_San_Francisco_Call) | low | 133 |
| [Fisherman's Wharf, San Francisco](https://en.wikipedia.org/wiki/Fisherman's_Wharf%2C_San_Francisco) | mid | 131 |
| [University of California Press](https://en.wikipedia.org/wiki/University_of_California_Press) | mid | 131 |
| [Martinez, California](https://en.wikipedia.org/wiki/Martinez%2C_California) | mid | 130 |
| [Emeryville, California](https://en.wikipedia.org/wiki/Emeryville%2C_California) | mid | 128 |
| [Beat Generation](https://en.wikipedia.org/wiki/Beat_Generation) | mid | 127 |
| [East Bay Regional Park District](https://en.wikipedia.org/wiki/East_Bay_Regional_Park_District) | mid | 126 |
| [Allen Ginsberg](https://en.wikipedia.org/wiki/Allen_Ginsberg) | mid | 125 |
| [Bayview–Hunters Point, San Francisco](https://en.wikipedia.org/wiki/Bayview%E2%80%93Hunters_Point%2C_San_Francisco) | mid | 125 |
| [Richmond District, San Francisco](https://en.wikipedia.org/wiki/Richmond_District%2C_San_Francisco) | mid | 125 |
| [Interstate 280 (California)](https://en.wikipedia.org/wiki/Interstate_280_(California)) | mid | 124 |
| [KNBR (AM)](https://en.wikipedia.org/wiki/KNBR_(AM)) | mid | 124 |
| [South San Francisco, California](https://en.wikipedia.org/wiki/South_San_Francisco%2C_California) | mid | 124 |
| [Milpitas, California](https://en.wikipedia.org/wiki/Milpitas%2C_California) | mid | 123 |
| [Colma, California](https://en.wikipedia.org/wiki/Colma%2C_California) | mid | 122 |
| [Bill Walsh Legacy Game](https://en.wikipedia.org/wiki/Bill_Walsh_Legacy_Game) | low | 121 |
| [Civic Center, San Francisco](https://en.wikipedia.org/wiki/Civic_Center%2C_San_Francisco) | mid | 121 |
| [Burlingame, California](https://en.wikipedia.org/wiki/Burlingame%2C_California) | mid | 119 |
| [Nob Hill, San Francisco](https://en.wikipedia.org/wiki/Nob_Hill%2C_San_Francisco) | mid | 119 |
| [San Bruno, California](https://en.wikipedia.org/wiki/San_Bruno%2C_California) | mid | 119 |
| [KRON-TV](https://en.wikipedia.org/wiki/KRON-TV) | mid | 118 |
| [Novato, California](https://en.wikipedia.org/wiki/Novato%2C_California) | mid | 116 |
| [Marin Independent Journal](https://en.wikipedia.org/wiki/Marin_Independent_Journal) | low | 115 |
| [El Cerrito, California](https://en.wikipedia.org/wiki/El_Cerrito%2C_California) | mid | 113 |
| [KSFO](https://en.wikipedia.org/wiki/KSFO) | mid | 113 |
| [Kamala Harris](https://en.wikipedia.org/wiki/Kamala_Harris) | mid | 111 |
| [SAP Center](https://en.wikipedia.org/wiki/SAP_Center) | mid | 111 |
| [San Francisco Public Library](https://en.wikipedia.org/wiki/San_Francisco_Public_Library) | mid | 109 |
| [California Golden Bears football](https://en.wikipedia.org/wiki/California_Golden_Bears_football) | mid | 108 |
| [Healdsburg, California](https://en.wikipedia.org/wiki/Healdsburg%2C_California) | mid | 106 |
| [Interstate 80 in California](https://en.wikipedia.org/wiki/Interstate_80_in_California) | *untagged* | 106 |
| [Area codes 415 and 628](https://en.wikipedia.org/wiki/Area_codes_415_and_628) | low | 105 |
| [Android (operating system)](https://en.wikipedia.org/wiki/Android_(operating_system)) | mid | 104 |
| [De Young Museum](https://en.wikipedia.org/wiki/De_Young_Museum) | mid | 104 |
| [Napa Valley Register](https://en.wikipedia.org/wiki/Napa_Valley_Register) | low | 104 |
| [Downtown Oakland](https://en.wikipedia.org/wiki/Downtown_Oakland) | low | 103 |
| [Pacifica, California](https://en.wikipedia.org/wiki/Pacifica%2C_California) | mid | 103 |
| [Dublin, California](https://en.wikipedia.org/wiki/Dublin%2C_California) | mid | 102 |
| [San Francisco Bay Guardian](https://en.wikipedia.org/wiki/San_Francisco_Bay_Guardian) | mid | 102 |
| [Salon.com](https://en.wikipedia.org/wiki/Salon.com) | mid | 101 |
| [Sierra Club](https://en.wikipedia.org/wiki/Sierra_Club) | *untagged* | 101 |
| [Antioch, California](https://en.wikipedia.org/wiki/Antioch%2C_California) | mid | 99 |
| [Interstate 580 (California)](https://en.wikipedia.org/wiki/Interstate_580_(California)) | *untagged* | 99 |
| [Los Altos, California](https://en.wikipedia.org/wiki/Los_Altos%2C_California) | mid | 99 |
| [Sobrato Center](https://en.wikipedia.org/wiki/Sobrato_Center) | low | 99 |
| [Stanford Cardinal football](https://en.wikipedia.org/wiki/Stanford_Cardinal_football) | mid | 99 |
| [Archdiocese of San Francisco](https://en.wikipedia.org/wiki/Archdiocese_of_San_Francisco) | mid | 98 |
| [St. Helena, California](https://en.wikipedia.org/wiki/St._Helena%2C_California) | mid | 98 |
| [Tiburon, California](https://en.wikipedia.org/wiki/Tiburon%2C_California) | mid | 98 |
| [Diablo Range](https://en.wikipedia.org/wiki/Diablo_Range) | mid | 97 |
| [Pacific Heights, San Francisco](https://en.wikipedia.org/wiki/Pacific_Heights%2C_San_Francisco) | low | 97 |
| [Nancy Pelosi](https://en.wikipedia.org/wiki/Nancy_Pelosi) | mid | 96 |
| [Santa Cruz County, California](https://en.wikipedia.org/wiki/Santa_Cruz_County%2C_California) | mid | 96 |
| [California county routes in zone G](https://en.wikipedia.org/wiki/California_county_routes_in_zone_G) | *untagged* | 95 |
| [Counterculture of the 1960s](https://en.wikipedia.org/wiki/Counterculture_of_the_1960s) | mid | 95 |
| [East Bay Express](https://en.wikipedia.org/wiki/East_Bay_Express) | mid | 95 |
| [Gilroy, California](https://en.wikipedia.org/wiki/Gilroy%2C_California) | mid | 95 |
| [Benicia, California](https://en.wikipedia.org/wiki/Benicia%2C_California) | mid | 94 |
| [San Ramon, California](https://en.wikipedia.org/wiki/San_Ramon%2C_California) | mid | 94 |
| [Mission Street](https://en.wikipedia.org/wiki/Mission_Street) | mid | 93 |
| [U.S. Route 101](https://en.wikipedia.org/wiki/U.S._Route_101) | low | 93 |
| [Woodside, California](https://en.wikipedia.org/wiki/Woodside%2C_California) | mid | 93 |
| [Russian Hill, San Francisco](https://en.wikipedia.org/wiki/Russian_Hill%2C_San_Francisco) | mid | 92 |
| [Sonoma State University](https://en.wikipedia.org/wiki/Sonoma_State_University) | mid | 92 |
| [San Jose Sharks](https://en.wikipedia.org/wiki/San_Jose_Sharks) | mid | 91 |
| [Morgan Hill, California](https://en.wikipedia.org/wiki/Morgan_Hill%2C_California) | mid | 90 |
| [Western Addition, San Francisco](https://en.wikipedia.org/wiki/Western_Addition%2C_San_Francisco) | low | 90 |
| [Albany, California](https://en.wikipedia.org/wiki/Albany%2C_California) | mid | 89 |
| [San Francisco Municipal Transportation Agency](https://en.wikipedia.org/wiki/San_Francisco_Municipal_Transportation_Agency) | mid | 89 |
| [Sebastopol, California](https://en.wikipedia.org/wiki/Sebastopol%2C_California) | low | 89 |
| [United States District Court for the Northern District of California](https://en.wikipedia.org/wiki/United_States_District_Court_for_the_Northern_District_of_California) | mid | 89 |
| [Danville, California](https://en.wikipedia.org/wiki/Danville%2C_California) | mid | 88 |
| [Ed Lee](https://en.wikipedia.org/wiki/Ed_Lee) | mid | 88 |
| [Piedmont, California](https://en.wikipedia.org/wiki/Piedmont%2C_California) | mid | 88 |
| [United States Court of Appeals for the Ninth Circuit](https://en.wikipedia.org/wiki/United_States_Court_of_Appeals_for_the_Ninth_Circuit) | *untagged* | 88 |
| [California–UCLA football rivalry](https://en.wikipedia.org/wiki/California%E2%80%93UCLA_football_rivalry) | low | 87 |
| [Olympic Club](https://en.wikipedia.org/wiki/Olympic_Club) | mid | 87 |
| [Saratoga, California](https://en.wikipedia.org/wiki/Saratoga%2C_California) | mid | 87 |
| [University Credit Union Pavilion](https://en.wikipedia.org/wiki/University_Credit_Union_Pavilion) | low | 87 |
| [Van Ness Avenue](https://en.wikipedia.org/wiki/Van_Ness_Avenue) | mid | 87 |
| [Battle for the Valley](https://en.wikipedia.org/wiki/Battle_for_the_Valley) | low | 85 |
| [Newark, California](https://en.wikipedia.org/wiki/Newark%2C_California) | mid | 85 |
| [Lafayette, California](https://en.wikipedia.org/wiki/Lafayette%2C_California) | mid | 84 |
| [Levi's Stadium](https://en.wikipedia.org/wiki/Levi's_Stadium) | mid | 84 |
| [Market Street Railway (transit operator)](https://en.wikipedia.org/wiki/Market_Street_Railway_(transit_operator)) | mid | 83 |
| [Area codes 707 and 369](https://en.wikipedia.org/wiki/Area_codes_707_and_369) | low | 82 |
| [Instagram](https://en.wikipedia.org/wiki/Instagram) | low | 81 |
| [Metallica](https://en.wikipedia.org/wiki/Metallica) | low | 81 |
| [Campbell, California](https://en.wikipedia.org/wiki/Campbell%2C_California) | mid | 79 |
| [Marina District, San Francisco](https://en.wikipedia.org/wiki/Marina_District%2C_San_Francisco) | mid | 79 |
| [Atherton, California](https://en.wikipedia.org/wiki/Atherton%2C_California) | mid | 78 |
| [El Camino Real (California)](https://en.wikipedia.org/wiki/El_Camino_Real_(California)) | *untagged* | 78 |
| [Orinda, California](https://en.wikipedia.org/wiki/Orinda%2C_California) | mid | 78 |
| [VentureBeat](https://en.wikipedia.org/wiki/VentureBeat) | *untagged* | 78 |
| [Business Wire](https://en.wikipedia.org/wiki/Business_Wire) | low | 77 |
| [Fairfield, California](https://en.wikipedia.org/wiki/Fairfield%2C_California) | mid | 77 |
| [Rohnert Park, California](https://en.wikipedia.org/wiki/Rohnert_Park%2C_California) | low | 77 |
| [Millbrae, California](https://en.wikipedia.org/wiki/Millbrae%2C_California) | mid | 76 |
| [PayPal](https://en.wikipedia.org/wiki/PayPal) | mid | 76 |
| [Pomo](https://en.wikipedia.org/wiki/Pomo) | mid | 76 |
| [Mission Bay, San Francisco](https://en.wikipedia.org/wiki/Mission_Bay%2C_San_Francisco) | mid | 75 |
| [Stanford–USC football rivalry](https://en.wikipedia.org/wiki/Stanford%E2%80%93USC_football_rivalry) | unknown | 75 |
| [Golden Gate International Exposition](https://en.wikipedia.org/wiki/Golden_Gate_International_Exposition) | mid | 74 |
| [Potrero Hill](https://en.wikipedia.org/wiki/Potrero_Hill) | mid | 74 |
| [San Carlos, California](https://en.wikipedia.org/wiki/San_Carlos%2C_California) | mid | 74 |
| [Bill Walsh](https://en.wikipedia.org/wiki/Bill_Walsh) | *untagged* | 73 |
| [Capitol Corridor](https://en.wikipedia.org/wiki/Capitol_Corridor) | mid | 73 |
| [IGN](https://en.wikipedia.org/wiki/IGN) | mid | 73 |
| [San Francisco Transbay Terminal](https://en.wikipedia.org/wiki/San_Francisco_Transbay_Terminal) | mid | 73 |
| [Altamont Corridor Express](https://en.wikipedia.org/wiki/Altamont_Corridor_Express) | low | 72 |
| [Castro Valley, California](https://en.wikipedia.org/wiki/Castro_Valley%2C_California) | mid | 72 |
| [Fillmore District, San Francisco](https://en.wikipedia.org/wiki/Fillmore_District%2C_San_Francisco) | mid | 71 |
| [San Jose Earthquakes](https://en.wikipedia.org/wiki/San_Jose_Earthquakes) | low | 71 |
| [Telegraph Hill, San Francisco](https://en.wikipedia.org/wiki/Telegraph_Hill%2C_San_Francisco) | mid | 71 |
| [Victory Bell (Pacific–San Jose State)](https://en.wikipedia.org/wiki/Victory_Bell_(Pacific%E2%80%93San_Jose_State)) | unknown | 71 |
| [Berkeley High School (California)](https://en.wikipedia.org/wiki/Berkeley_High_School_(California)) | mid | 70 |
| [F Market & Wharves](https://en.wikipedia.org/wiki/F_Market_%26_Wharves) | mid | 70 |
| [San Francisco Ballet](https://en.wikipedia.org/wiki/San_Francisco_Ballet) | mid | 70 |
| [Angel Island (California)](https://en.wikipedia.org/wiki/Angel_Island_(California)) | mid | 69 |
| [List of acquisitions by Cisco](https://en.wikipedia.org/wiki/List_of_acquisitions_by_Cisco) | mid | 69 |
| [Mission San José (California)](https://en.wikipedia.org/wiki/Mission_San_Jos%C3%A9_(California)) | mid | 69 |
| [Port of Oakland](https://en.wikipedia.org/wiki/Port_of_Oakland) | *untagged* | 69 |
| [The Daily Californian](https://en.wikipedia.org/wiki/The_Daily_Californian) | low | 69 |
| [California Republic](https://en.wikipedia.org/wiki/California_Republic) | mid | 68 |
| [LinkedIn](https://en.wikipedia.org/wiki/LinkedIn) | low | 68 |
| [Salesforce](https://en.wikipedia.org/wiki/Salesforce) | mid | 68 |
| [San Francisco Recreation & Parks Department](https://en.wikipedia.org/wiki/San_Francisco_Recreation_%26_Parks_Department) | mid | 68 |
| [Sequoia Capital](https://en.wikipedia.org/wiki/Sequoia_Capital) | mid | 68 |
| [Calistoga, California](https://en.wikipedia.org/wiki/Calistoga%2C_California) | mid | 67 |
| [Lowell High School (San Francisco)](https://en.wikipedia.org/wiki/Lowell_High_School_(San_Francisco)) | mid | 67 |
| [The San Francisco Standard](https://en.wikipedia.org/wiki/The_San_Francisco_Standard) | low | 67 |
| [San Jose Giants](https://en.wikipedia.org/wiki/San_Jose_Giants) | low | 66 |
| [American Conservatory Theater](https://en.wikipedia.org/wiki/American_Conservatory_Theater) | mid | 65 |
| [Haas Pavilion](https://en.wikipedia.org/wiki/Haas_Pavilion) | low | 65 |
| [Telegraph Avenue](https://en.wikipedia.org/wiki/Telegraph_Avenue) | mid | 65 |
| [Foster City, California](https://en.wikipedia.org/wiki/Foster_City%2C_California) | mid | 64 |
| [Pittsburg, California](https://en.wikipedia.org/wiki/Pittsburg%2C_California) | mid | 64 |
| [San Francisco Pride](https://en.wikipedia.org/wiki/San_Francisco_Pride) | mid | 64 |
| [The Fillmore](https://en.wikipedia.org/wiki/The_Fillmore) | mid | 64 |
| [Bayshore Freeway](https://en.wikipedia.org/wiki/Bayshore_Freeway) | mid | 63 |
| [Geary Boulevard](https://en.wikipedia.org/wiki/Geary_Boulevard) | mid | 63 |
| [Hillsborough, California](https://en.wikipedia.org/wiki/Hillsborough%2C_California) | mid | 63 |
| [Mission Santa Clara de Asís](https://en.wikipedia.org/wiki/Mission_Santa_Clara_de_As%C3%ADs) | low | 63 |
| [Belmont, California](https://en.wikipedia.org/wiki/Belmont%2C_California) | mid | 62 |
| [Bernard Maybeck](https://en.wikipedia.org/wiki/Bernard_Maybeck) | mid | 62 |
| [Brisbane, California](https://en.wikipedia.org/wiki/Brisbane%2C_California) | mid | 62 |
| [California's 11th senatorial district](https://en.wikipedia.org/wiki/California's_11th_senatorial_district) | mid | 62 |
| [Coit Tower](https://en.wikipedia.org/wiki/Coit_Tower) | mid | 62 |
| [Bolinas, California](https://en.wikipedia.org/wiki/Bolinas%2C_California) | mid | 61 |
| [Clint Eastwood](https://en.wikipedia.org/wiki/Clint_Eastwood) | mid | 61 |
| [East Palo Alto, California](https://en.wikipedia.org/wiki/East_Palo_Alto%2C_California) | mid | 61 |
| [San Jose State Spartans football](https://en.wikipedia.org/wiki/San_Jose_State_Spartans_football) | mid | 61 |
| [Stanford University School of Medicine](https://en.wikipedia.org/wiki/Stanford_University_School_of_Medicine) | mid | 61 |
| [California State Route 17](https://en.wikipedia.org/wiki/California_State_Route_17) | mid | 60 |
| [East Oakland, Oakland, California](https://en.wikipedia.org/wiki/East_Oakland%2C_Oakland%2C_California) | low | 60 |
| [Northwestern Pacific Railroad](https://en.wikipedia.org/wiki/Northwestern_Pacific_Railroad) | low | 60 |
| [Oakland Unified School District](https://en.wikipedia.org/wiki/Oakland_Unified_School_District) | mid | 60 |
| [Ocean Beach, San Francisco](https://en.wikipedia.org/wiki/Ocean_Beach%2C_San_Francisco) | mid | 60 |
| [San Francisco Bay Ferry](https://en.wikipedia.org/wiki/San_Francisco_Bay_Ferry) | low | 60 |
| [San Francisco Opera](https://en.wikipedia.org/wiki/San_Francisco_Opera) | mid | 60 |
| [Uber](https://en.wikipedia.org/wiki/Uber) | low | 60 |
| [Vacaville, California](https://en.wikipedia.org/wiki/Vacaville%2C_California) | mid | 60 |
| [West Oakland, Oakland, California](https://en.wikipedia.org/wiki/West_Oakland%2C_Oakland%2C_California) | mid | 60 |
| [All Nighter (bus service)](https://en.wikipedia.org/wiki/All_Nighter_(bus_service)) | low | 59 |
| [California Golden Bears](https://en.wikipedia.org/wiki/California_Golden_Bears) | mid | 59 |
| [N Judah](https://en.wikipedia.org/wiki/N_Judah) | mid | 59 |
| [State Bar of California](https://en.wikipedia.org/wiki/State_Bar_of_California) | *untagged* | 59 |
| [West Side (San Francisco)](https://en.wikipedia.org/wiki/West_Side_(San_Francisco)) | low | 59 |
| [Brentwood, California](https://en.wikipedia.org/wiki/Brentwood%2C_California) | mid | 58 |
| [College of San Mateo](https://en.wikipedia.org/wiki/College_of_San_Mateo) | low | 58 |
| [Cox Stadium](https://en.wikipedia.org/wiki/Cox_Stadium) | *untagged* | 58 |
| [Jack London Square](https://en.wikipedia.org/wiki/Jack_London_Square) | mid | 58 |
| [List of lakes of the San Francisco Bay Area](https://en.wikipedia.org/wiki/List_of_lakes_of_the_San_Francisco_Bay_Area) | mid | 58 |
| [Los Altos Hills, California](https://en.wikipedia.org/wiki/Los_Altos_Hills%2C_California) | mid | 58 |
| [Montgomery Street](https://en.wikipedia.org/wiki/Montgomery_Street) | mid | 58 |
| [Pleasant Hill, California](https://en.wikipedia.org/wiki/Pleasant_Hill%2C_California) | mid | 58 |
| [San Pablo, California](https://en.wikipedia.org/wiki/San_Pablo%2C_California) | *untagged* | 58 |
| [Berkeley Art Museum and Pacific Film Archive](https://en.wikipedia.org/wiki/Berkeley_Art_Museum_and_Pacific_Film_Archive) | mid | 57 |
| [California State Route 123](https://en.wikipedia.org/wiki/California_State_Route_123) | *untagged* | 57 |
| [Miwok](https://en.wikipedia.org/wiki/Miwok) | unknown | 57 |
| [Nvidia](https://en.wikipedia.org/wiki/Nvidia) | mid | 57 |
| [San Francisco Arts Commission](https://en.wikipedia.org/wiki/San_Francisco_Arts_Commission) | low | 57 |
| [Santana (band)](https://en.wikipedia.org/wiki/Santana_(band)) | mid | 57 |
| [Bernal Heights, San Francisco](https://en.wikipedia.org/wiki/Bernal_Heights%2C_San_Francisco) | mid | 56 |
| [California State Route 24](https://en.wikipedia.org/wiki/California_State_Route_24) | low | 56 |
| [California's 12th State Assembly district](https://en.wikipedia.org/wiki/California's_12th_State_Assembly_district) | mid | 56 |
| [COVID-19 pandemic in the San Francisco Bay Area](https://en.wikipedia.org/wiki/COVID-19_pandemic_in_the_San_Francisco_Bay_Area) | unknown | 56 |
| [Cypress Lawn Memorial Park](https://en.wikipedia.org/wiki/Cypress_Lawn_Memorial_Park) | low | 56 |
| [Larkspur, California](https://en.wikipedia.org/wiki/Larkspur%2C_California) | mid | 56 |
| [Noe Valley, San Francisco](https://en.wikipedia.org/wiki/Noe_Valley%2C_San_Francisco) | mid | 56 |
| [Sonoma–Marin Area Rail Transit](https://en.wikipedia.org/wiki/Sonoma%E2%80%93Marin_Area_Rail_Transit) | mid | 56 |
| [Stanford Graduate School of Business](https://en.wikipedia.org/wiki/Stanford_Graduate_School_of_Business) | mid | 56 |
| [Japantown, San Francisco](https://en.wikipedia.org/wiki/Japantown%2C_San_Francisco) | mid | 55 |
| [San Francisco General Hospital](https://en.wikipedia.org/wiki/San_Francisco_General_Hospital) | mid | 55 |
| [San Jose Diridon station](https://en.wikipedia.org/wiki/San_Jose_Diridon_station) | mid | 55 |
| [Yountville, California](https://en.wikipedia.org/wiki/Yountville%2C_California) | *untagged* | 55 |
| [Computer History Museum](https://en.wikipedia.org/wiki/Computer_History_Museum) | low | 54 |
| [E-40](https://en.wikipedia.org/wiki/E-40) | low | 54 |
| [Haas School of Business](https://en.wikipedia.org/wiki/Haas_School_of_Business) | low | 54 |
| [Metro Silicon Valley](https://en.wikipedia.org/wiki/Metro_Silicon_Valley) | low | 54 |
| [Palace of Fine Arts](https://en.wikipedia.org/wiki/Palace_of_Fine_Arts) | mid | 54 |
| [Portola Valley, California](https://en.wikipedia.org/wiki/Portola_Valley%2C_California) | mid | 54 |
| [Primus (band)](https://en.wikipedia.org/wiki/Primus_(band)) | low | 54 |
| [Yerba Buena Island](https://en.wikipedia.org/wiki/Yerba_Buena_Island) | mid | 54 |
| [Aaron Peskin](https://en.wikipedia.org/wiki/Aaron_Peskin) | mid | 53 |
| [Bob Weir](https://en.wikipedia.org/wiki/Bob_Weir) | mid | 53 |
| [Bodega Bay](https://en.wikipedia.org/wiki/Bodega_Bay) | mid | 53 |
| [Cotati, California](https://en.wikipedia.org/wiki/Cotati%2C_California) | mid | 53 |
| [Holy Cross Cemetery (Colma, California)](https://en.wikipedia.org/wiki/Holy_Cross_Cemetery_(Colma%2C_California)) | mid | 53 |
| [Lon Simmons](https://en.wikipedia.org/wiki/Lon_Simmons) | unknown | 53 |
| [San Francisco and San Jose Railroad](https://en.wikipedia.org/wiki/San_Francisco_and_San_Jose_Railroad) | unknown | 53 |
| [The Stanford Daily](https://en.wikipedia.org/wiki/The_Stanford_Daily) | low | 53 |
| [Big Brother and the Holding Company](https://en.wikipedia.org/wiki/Big_Brother_and_the_Holding_Company) | mid | 52 |
| [Bleacher Report](https://en.wikipedia.org/wiki/Bleacher_Report) | *untagged* | 52 |
| [California Historical Society](https://en.wikipedia.org/wiki/California_Historical_Society) | *untagged* | 52 |
| [Charlie Finley](https://en.wikipedia.org/wiki/Charlie_Finley) | mid | 52 |
| [Gary Snyder](https://en.wikipedia.org/wiki/Gary_Snyder) | mid | 52 |
| [Joseph Alioto](https://en.wikipedia.org/wiki/Joseph_Alioto) | mid | 52 |
| [KCBS (AM)](https://en.wikipedia.org/wiki/KCBS_(AM)) | low | 52 |
| [National Register of Historic Places listings in Alameda County, California](https://en.wikipedia.org/wiki/National_Register_of_Historic_Places_listings_in_Alameda_County%2C_California) | mid | 52 |
| [National Register of Historic Places listings in San Francisco](https://en.wikipedia.org/wiki/National_Register_of_Historic_Places_listings_in_San_Francisco) | mid | 52 |
| [Point Reyes National Seashore](https://en.wikipedia.org/wiki/Point_Reyes_National_Seashore) | low | 52 |
| [Area code 650](https://en.wikipedia.org/wiki/Area_code_650) | low | 51 |
| [California Street (San Francisco)](https://en.wikipedia.org/wiki/California_Street_(San_Francisco)) | low | 51 |
| [Chase Center](https://en.wikipedia.org/wiki/Chase_Center) | low | 51 |
| [Fine Arts Museums of San Francisco](https://en.wikipedia.org/wiki/Fine_Arts_Museums_of_San_Francisco) | mid | 51 |
| [Herbert Hoover](https://en.wikipedia.org/wiki/Herbert_Hoover) | mid | 51 |
| [J Church](https://en.wikipedia.org/wiki/J_Church) | low | 51 |
| [Juan Bautista Alvarado](https://en.wikipedia.org/wiki/Juan_Bautista_Alvarado) | *untagged* | 51 |
| [Lake Merced](https://en.wikipedia.org/wiki/Lake_Merced) | mid | 51 |
| [List of San Francisco 49ers seasons](https://en.wikipedia.org/wiki/List_of_San_Francisco_49ers_seasons) | mid | 51 |
| [Mountain View Cemetery (Oakland, California)](https://en.wikipedia.org/wiki/Mountain_View_Cemetery_(Oakland%2C_California)) | mid | 51 |
| [Ridgway's rail](https://en.wikipedia.org/wiki/Ridgway's_rail) | mid | 51 |
| [Salesforce Transit Center](https://en.wikipedia.org/wiki/Salesforce_Transit_Center) | mid | 51 |
| [San Anselmo, California](https://en.wikipedia.org/wiki/San_Anselmo%2C_California) | mid | 51 |

## Appendix B — all 296 drops

| Article | Current rating | Inlinks |
|---|---|---|
| [California State Route 480](https://en.wikipedia.org/wiki/California_State_Route_480) | high | 50 |
| [Las Vegas Raiders](https://en.wikipedia.org/wiki/Las_Vegas_Raiders) | high | 50 |
| [Stanford Law School](https://en.wikipedia.org/wiki/Stanford_Law_School) | high | 50 |
| [Walter A. Haas Jr.](https://en.wikipedia.org/wiki/Walter_A._Haas_Jr.) | high | 50 |
| [Cisco](https://en.wikipedia.org/wiki/Cisco) | high | 49 |
| [Government of San Francisco](https://en.wikipedia.org/wiki/Government_of_San_Francisco) | high | 49 |
| [James D. Phelan](https://en.wikipedia.org/wiki/James_D._Phelan) | high | 49 |
| [James Rolph](https://en.wikipedia.org/wiki/James_Rolph) | high | 49 |
| [Point Reyes](https://en.wikipedia.org/wiki/Point_Reyes) | top | 49 |
| [Wine Country](https://en.wikipedia.org/wiki/Wine_Country) | top | 49 |
| [Assassinations of George Moscone and Harvey Milk](https://en.wikipedia.org/wiki/Assassinations_of_George_Moscone_and_Harvey_Milk) | top | 48 |
| [Gap Inc.](https://en.wikipedia.org/wiki/Gap_Inc.) | high | 48 |
| [Willis Polk](https://en.wikipedia.org/wiki/Willis_Polk) | high | 48 |
| [Ames Research Center](https://en.wikipedia.org/wiki/Ames_Research_Center) | high | 47 |
| [Athletics (baseball)](https://en.wikipedia.org/wiki/Athletics_(baseball)) | high | 47 |
| [Free Speech Movement](https://en.wikipedia.org/wiki/Free_Speech_Movement) | high | 47 |
| [Ken Kesey](https://en.wikipedia.org/wiki/Ken_Kesey) | high | 47 |
| [San Mateo–Hayward Bridge](https://en.wikipedia.org/wiki/San_Mateo%E2%80%93Hayward_Bridge) | top | 47 |
| [Barbara Boxer](https://en.wikipedia.org/wiki/Barbara_Boxer) | high | 46 |
| [Fairmont San Francisco](https://en.wikipedia.org/wiki/Fairmont_San_Francisco) | high | 46 |
| [Alphabet Inc.](https://en.wikipedia.org/wiki/Alphabet_Inc.) | high | 45 |
| [San Francisco Renaissance](https://en.wikipedia.org/wiki/San_Francisco_Renaissance) | high | 45 |
| [Sonoma Creek](https://en.wikipedia.org/wiki/Sonoma_Creek) | high | 45 |
| [Stanford University Medical Center](https://en.wikipedia.org/wiki/Stanford_University_Medical_Center) | high | 45 |
| [Willie McCovey](https://en.wikipedia.org/wiki/Willie_McCovey) | high | 45 |
| [Ferries of San Francisco Bay](https://en.wikipedia.org/wiki/Ferries_of_San_Francisco_Bay) | high | 44 |
| [Jerry Rice](https://en.wikipedia.org/wiki/Jerry_Rice) | high | 44 |
| [KPFA](https://en.wikipedia.org/wiki/KPFA) | high | 44 |
| [Lucasfilm](https://en.wikipedia.org/wiki/Lucasfilm) | high | 44 |
| [Naval Air Station Alameda](https://en.wikipedia.org/wiki/Naval_Air_Station_Alameda) | high | 44 |
| [Academy of Art University](https://en.wikipedia.org/wiki/Academy_of_Art_University) | high | 43 |
| [LGBTQ culture in San Francisco](https://en.wikipedia.org/wiki/LGBTQ_culture_in_San_Francisco) | high | 43 |
| [Alcatraz Federal Penitentiary](https://en.wikipedia.org/wiki/Alcatraz_Federal_Penitentiary) | top | 42 |
| [California Public Utilities Commission](https://en.wikipedia.org/wiki/California_Public_Utilities_Commission) | high | 42 |
| [Gaspar de Portolá](https://en.wikipedia.org/wiki/Gaspar_de_Portol%C3%A1) | high | 42 |
| [Ron Dellums](https://en.wikipedia.org/wiki/Ron_Dellums) | high | 42 |
| [Bechtel](https://en.wikipedia.org/wiki/Bechtel) | high | 40 |
| [Chez Panisse](https://en.wikipedia.org/wiki/Chez_Panisse) | high | 40 |
| [Dumbarton Bridge (California)](https://en.wikipedia.org/wiki/Dumbarton_Bridge_(California)) | high | 40 |
| [Journey (band)](https://en.wikipedia.org/wiki/Journey_(band)) | high | 40 |
| [Mount Hamilton (California)](https://en.wikipedia.org/wiki/Mount_Hamilton_(California)) | top | 40 |
| [Netscape](https://en.wikipedia.org/wiki/Netscape) | high | 40 |
| [Richmond–San Rafael Bridge](https://en.wikipedia.org/wiki/Richmond%E2%80%93San_Rafael_Bridge) | top | 40 |
| [AMD](https://en.wikipedia.org/wiki/AMD) | high | 39 |
| [Earl Warren](https://en.wikipedia.org/wiki/Earl_Warren) | high | 39 |
| [Fort Point National Historic Site](https://en.wikipedia.org/wiki/Fort_Point_National_Historic_Site) | high | 39 |
| [PARC (company)](https://en.wikipedia.org/wiki/PARC_(company)) | high | 39 |
| [Sonoma County wine](https://en.wikipedia.org/wiki/Sonoma_County_wine) | high | 39 |
| [Stanford University centers and institutes](https://en.wikipedia.org/wiki/Stanford_University_centers_and_institutes) | high | 39 |
| [Bobby Seale](https://en.wikipedia.org/wiki/Bobby_Seale) | high | 38 |
| [Grace Cathedral, San Francisco](https://en.wikipedia.org/wiki/Grace_Cathedral%2C_San_Francisco) | high | 38 |
| [San Francisco Fire Department](https://en.wikipedia.org/wiki/San_Francisco_Fire_Department) | high | 38 |
| [Tony La Russa](https://en.wikipedia.org/wiki/Tony_La_Russa) | high | 38 |
| [Muir Woods National Monument](https://en.wikipedia.org/wiki/Muir_Woods_National_Monument) | high | 37 |
| [Palace Hotel, San Francisco](https://en.wikipedia.org/wiki/Palace_Hotel%2C_San_Francisco) | high | 37 |
| [Reggie Jackson](https://en.wikipedia.org/wiki/Reggie_Jackson) | high | 37 |
| [1989 World Series](https://en.wikipedia.org/wiki/1989_World_Series) | high | 36 |
| [Bay Area Ridge Trail](https://en.wikipedia.org/wiki/Bay_Area_Ridge_Trail) | high | 35 |
| [Richardson Bay](https://en.wikipedia.org/wiki/Richardson_Bay) | high | 35 |
| [Sunset (magazine)](https://en.wikipedia.org/wiki/Sunset_(magazine)) | high | 35 |
| [Alfred Kroeber](https://en.wikipedia.org/wiki/Alfred_Kroeber) | high | 33 |
| [Alice Waters](https://en.wikipedia.org/wiki/Alice_Waters) | high | 33 |
| [UCSF Medical Center](https://en.wikipedia.org/wiki/UCSF_Medical_Center) | high | 33 |
| [California Pacific Medical Center](https://en.wikipedia.org/wiki/California_Pacific_Medical_Center) | high | 32 |
| [David Packard](https://en.wikipedia.org/wiki/David_Packard) | high | 32 |
| [Juan Marichal](https://en.wikipedia.org/wiki/Juan_Marichal) | high | 32 |
| [San Francisco Mint](https://en.wikipedia.org/wiki/San_Francisco_Mint) | high | 32 |
| [Bolinas Lagoon](https://en.wikipedia.org/wiki/Bolinas_Lagoon) | high | 31 |
| [Daniel Lurie](https://en.wikipedia.org/wiki/Daniel_Lurie) | high | 31 |
| [Dorothea Lange](https://en.wikipedia.org/wiki/Dorothea_Lange) | high | 31 |
| [Genentech](https://en.wikipedia.org/wiki/Genentech) | high | 31 |
| [Hearst Communications](https://en.wikipedia.org/wiki/Hearst_Communications) | high | 31 |
| [Milk (2008 American film)](https://en.wikipedia.org/wiki/Milk_(2008_American_film)) | high | 31 |
| [Charles Crocker](https://en.wikipedia.org/wiki/Charles_Crocker) | high | 30 |
| [Lake Berryessa](https://en.wikipedia.org/wiki/Lake_Berryessa) | high | 30 |
| [Silicon Graphics](https://en.wikipedia.org/wiki/Silicon_Graphics) | high | 30 |
| [Zodiac Killer](https://en.wikipedia.org/wiki/Zodiac_Killer) | high | 30 |
| [Bank of California](https://en.wikipedia.org/wiki/Bank_of_California) | high | 29 |
| [Clark Kerr](https://en.wikipedia.org/wiki/Clark_Kerr) | high | 29 |
| [Craigslist](https://en.wikipedia.org/wiki/Craigslist) | high | 29 |
| [Gordon Moore](https://en.wikipedia.org/wiki/Gordon_Moore) | high | 29 |
| [Hamilton Field (Hamilton AFB)](https://en.wikipedia.org/wiki/Hamilton_Field_(Hamilton_AFB)) | high | 29 |
| [J. Robert Oppenheimer](https://en.wikipedia.org/wiki/J._Robert_Oppenheimer) | high | 29 |
| [Super Bowl 50](https://en.wikipedia.org/wiki/Super_Bowl_50) | high | 29 |
| [Bodega Bay, California](https://en.wikipedia.org/wiki/Bodega_Bay%2C_California) | high | 28 |
| [Occupation of Alcatraz](https://en.wikipedia.org/wiki/Occupation_of_Alcatraz) | high | 28 |
| [San Francisco Transbay development](https://en.wikipedia.org/wiki/San_Francisco_Transbay_development) | high | 28 |
| [2010 World Series](https://en.wikipedia.org/wiki/2010_World_Series) | high | 27 |
| [2012 World Series](https://en.wikipedia.org/wiki/2012_World_Series) | high | 27 |
| [Alameda County Board of Supervisors](https://en.wikipedia.org/wiki/Alameda_County_Board_of_Supervisors) | high | 27 |
| [Crystal Springs Reservoir](https://en.wikipedia.org/wiki/Crystal_Springs_Reservoir) | high | 27 |
| [Glenn T. Seaborg](https://en.wikipedia.org/wiki/Glenn_T._Seaborg) | high | 27 |
| [Oakland firestorm of 1991](https://en.wikipedia.org/wiki/Oakland_firestorm_of_1991) | high | 27 |
| [Phillip Burton](https://en.wikipedia.org/wiki/Phillip_Burton) | high | 27 |
| [Randy Shilts](https://en.wikipedia.org/wiki/Randy_Shilts) | high | 27 |
| [West Marin](https://en.wikipedia.org/wiki/West_Marin) | high | 27 |
| [Claus Spreckels](https://en.wikipedia.org/wiki/Claus_Spreckels) | high | 26 |
| [Norman Mineta](https://en.wikipedia.org/wiki/Norman_Mineta) | high | 26 |
| [Bill Hewlett](https://en.wikipedia.org/wiki/Bill_Hewlett) | high | 25 |
| [Bill Lockyer](https://en.wikipedia.org/wiki/Bill_Lockyer) | high | 25 |
| [Central Freeway](https://en.wikipedia.org/wiki/Central_Freeway) | high | 25 |
| [Members of the San Francisco Board of Supervisors](https://en.wikipedia.org/wiki/Members_of_the_San_Francisco_Board_of_Supervisors) | high | 25 |
| [Montara Mountain](https://en.wikipedia.org/wiki/Montara_Mountain) | high | 25 |
| [Richmond Shipyards](https://en.wikipedia.org/wiki/Richmond_Shipyards) | high | 25 |
| [Seagate Technology](https://en.wikipedia.org/wiki/Seagate_Technology) | high | 25 |
| [Bank of America (1904–1998)](https://en.wikipedia.org/wiki/Bank_of_America_(1904%E2%80%931998)) | high | 24 |
| [Charter of the United Nations](https://en.wikipedia.org/wiki/Charter_of_the_United_Nations) | high | 24 |
| [Cypress Street Viaduct](https://en.wikipedia.org/wiki/Cypress_Street_Viaduct) | high | 24 |
| [Human Be-In](https://en.wikipedia.org/wiki/Human_Be-In) | high | 24 |
| [Jim Jones](https://en.wikipedia.org/wiki/Jim_Jones) | high | 24 |
| [John McLaren (horticulturist)](https://en.wikipedia.org/wiki/John_McLaren_(horticulturist)) | high | 24 |
| [Leland Yee](https://en.wikipedia.org/wiki/Leland_Yee) | high | 24 |
| [Plutonium](https://en.wikipedia.org/wiki/Plutonium) | high | 24 |
| [Salesforce Tower](https://en.wikipedia.org/wiki/Salesforce_Tower) | high | 24 |
| [The Kingston Trio](https://en.wikipedia.org/wiki/The_Kingston_Trio) | high | 24 |
| [Benjamin Ide Wheeler](https://en.wikipedia.org/wiki/Benjamin_Ide_Wheeler) | high | 23 |
| [Greater Farallones National Marine Sanctuary](https://en.wikipedia.org/wiki/Greater_Farallones_National_Marine_Sanctuary) | high | 23 |
| [Hiram Johnson](https://en.wikipedia.org/wiki/Hiram_Johnson) | high | 23 |
| [Luther Burbank](https://en.wikipedia.org/wiki/Luther_Burbank) | high | 23 |
| [October 2017 Northern California wildfires](https://en.wikipedia.org/wiki/October_2017_Northern_California_wildfires) | top | 23 |
| [Pacific Bell](https://en.wikipedia.org/wiki/Pacific_Bell) | high | 23 |
| [Peoples Temple](https://en.wikipedia.org/wiki/Peoples_Temple) | high | 23 |
| [Tubbs Fire](https://en.wikipedia.org/wiki/Tubbs_Fire) | high | 23 |
| [1974 World Series](https://en.wikipedia.org/wiki/1974_World_Series) | high | 22 |
| [David Starr Jordan](https://en.wikipedia.org/wiki/David_Starr_Jordan) | high | 22 |
| [Eastern span replacement of the San Francisco–Oakland Bay Bridge](https://en.wikipedia.org/wiki/Eastern_span_replacement_of_the_San_Francisco%E2%80%93Oakland_Bay_Bridge) | top | 22 |
| [James Lick](https://en.wikipedia.org/wiki/James_Lick) | high | 22 |
| [KSAN (FM)](https://en.wikipedia.org/wiki/KSAN_(FM)) | high | 22 |
| [List of cities and towns in the San Francisco Bay Area](https://en.wikipedia.org/wiki/List_of_cities_and_towns_in_the_San_Francisco_Bay_Area) | top | 22 |
| [William Knowland](https://en.wikipedia.org/wiki/William_Knowland) | high | 22 |
| [Joseph R. Knowland](https://en.wikipedia.org/wiki/Joseph_R._Knowland) | high | 21 |
| [New Almaden](https://en.wikipedia.org/wiki/New_Almaden) | high | 21 |
| [NeXT](https://en.wikipedia.org/wiki/NeXT) | high | 21 |
| [Save the Bay](https://en.wikipedia.org/wiki/Save_the_Bay) | high | 21 |
| [George Hearst](https://en.wikipedia.org/wiki/George_Hearst) | high | 20 |
| [History of San Francisco](https://en.wikipedia.org/wiki/History_of_San_Francisco) | top | 20 |
| [Jack London State Historic Park](https://en.wikipedia.org/wiki/Jack_London_State_Historic_Park) | high | 20 |
| [Visa Inc.](https://en.wikipedia.org/wiki/Visa_Inc.) | high | 20 |
| [Alameda (island)](https://en.wikipedia.org/wiki/Alameda_(island)) | high | 19 |
| [Alma de Bretteville Spreckels](https://en.wikipedia.org/wiki/Alma_de_Bretteville_Spreckels) | high | 19 |
| [Andrew Grove](https://en.wikipedia.org/wiki/Andrew_Grove) | high | 19 |
| [Cal Poly Maritime Academy](https://en.wikipedia.org/wiki/Cal_Poly_Maritime_Academy) | high | 19 |
| [John Lasseter](https://en.wikipedia.org/wiki/John_Lasseter) | high | 19 |
| [Palm, Inc.](https://en.wikipedia.org/wiki/Palm%2C_Inc.) | high | 19 |
| [1972 World Series](https://en.wikipedia.org/wiki/1972_World_Series) | high | 18 |
| [2014 South Napa earthquake](https://en.wikipedia.org/wiki/2014_South_Napa_earthquake) | high | 18 |
| [Japanese Tea Garden (San Francisco)](https://en.wikipedia.org/wiki/Japanese_Tea_Garden_(San_Francisco)) | high | 18 |
| [Samuel Brannan](https://en.wikipedia.org/wiki/Samuel_Brannan) | high | 18 |
| [San Francisco State Gators](https://en.wikipedia.org/wiki/San_Francisco_State_Gators) | high | 18 |
| [Conservatory of Flowers](https://en.wikipedia.org/wiki/Conservatory_of_Flowers) | high | 17 |
| [Gayle McLaughlin](https://en.wikipedia.org/wiki/Gayle_McLaughlin) | high | 17 |
| [SLAC National Accelerator Laboratory](https://en.wikipedia.org/wiki/SLAC_National_Accelerator_Laboratory) | high | 17 |
| [The French Laundry](https://en.wikipedia.org/wiki/The_French_Laundry) | high | 17 |
| [Twitter, Inc.](https://en.wikipedia.org/wiki/Twitter%2C_Inc.) | high | 17 |
| [1973 World Series](https://en.wikipedia.org/wiki/1973_World_Series) | high | 16 |
| [Bay Area Council](https://en.wikipedia.org/wiki/Bay_Area_Council) | high | 16 |
| [David C. Broderick](https://en.wikipedia.org/wiki/David_C._Broderick) | high | 16 |
| [Filoli](https://en.wikipedia.org/wiki/Filoli) | high | 16 |
| [I. Magnin](https://en.wikipedia.org/wiki/I._Magnin) | high | 16 |
| [Jeff Tedford](https://en.wikipedia.org/wiki/Jeff_Tedford) | high | 16 |
| [S. I. Hayakawa](https://en.wikipedia.org/wiki/S._I._Hayakawa) | high | 16 |
| [The Play (American football)](https://en.wikipedia.org/wiki/The_Play_(American_football)) | high | 16 |
| [Walter A. Haas](https://en.wikipedia.org/wiki/Walter_A._Haas) | high | 16 |
| [1923 Berkeley, California, fire](https://en.wikipedia.org/wiki/1923_Berkeley%2C_California%2C_fire) | high | 15 |
| [Albert Ghiorso](https://en.wikipedia.org/wiki/Albert_Ghiorso) | high | 15 |
| [Del Monte Foods](https://en.wikipedia.org/wiki/Del_Monte_Foods) | high | 15 |
| [Dolby](https://en.wikipedia.org/wiki/Dolby) | high | 15 |
| [George P. Miller](https://en.wikipedia.org/wiki/George_P._Miller) | high | 15 |
| [HP Inc.](https://en.wikipedia.org/wiki/HP_Inc.) | top | 15 |
| [Kevin Starr](https://en.wikipedia.org/wiki/Kevin_Starr) | high | 15 |
| [Montgomery Block](https://en.wikipedia.org/wiki/Montgomery_Block) | high | 15 |
| [Mount Tamalpais State Park](https://en.wikipedia.org/wiki/Mount_Tamalpais_State_Park) | high | 15 |
| [National Semiconductor](https://en.wikipedia.org/wiki/National_Semiconductor) | high | 15 |
| [Robert Noyce](https://en.wikipedia.org/wiki/Robert_Noyce) | high | 15 |
| [Ryan Coogler](https://en.wikipedia.org/wiki/Ryan_Coogler) | high | 15 |
| [San Francisco Chinese New Year Festival and Parade](https://en.wikipedia.org/wiki/San_Francisco_Chinese_New_Year_Festival_and_Parade) | high | 15 |
| [Sony Interactive Entertainment](https://en.wikipedia.org/wiki/Sony_Interactive_Entertainment) | high | 15 |
| [2003 San Francisco mayoral election](https://en.wikipedia.org/wiki/2003_San_Francisco_mayoral_election) | high | 14 |
| [Jasper O'Farrell](https://en.wikipedia.org/wiki/Jasper_O'Farrell) | high | 14 |
| [List of University of California, Berkeley faculty](https://en.wikipedia.org/wiki/List_of_University_of_California%2C_Berkeley_faculty) | high | 14 |
| [Robert Gordon Sproul](https://en.wikipedia.org/wiki/Robert_Gordon_Sproul) | high | 14 |
| [Tom Campbell (California politician)](https://en.wikipedia.org/wiki/Tom_Campbell_(California_politician)) | high | 14 |
| [William Shockley](https://en.wikipedia.org/wiki/William_Shockley) | high | 14 |
| [2011 San Francisco mayoral election](https://en.wikipedia.org/wiki/2011_San_Francisco_mayoral_election) | high | 13 |
| [Año Nuevo State Park](https://en.wikipedia.org/wiki/A%C3%B1o_Nuevo_State_Park) | high | 13 |
| [Applied Materials](https://en.wikipedia.org/wiki/Applied_Materials) | high | 13 |
| [Concord Naval Weapons Station](https://en.wikipedia.org/wiki/Concord_Naval_Weapons_Station) | high | 13 |
| [Edward Teller](https://en.wikipedia.org/wiki/Edward_Teller) | high | 13 |
| [Hubert Howe Bancroft](https://en.wikipedia.org/wiki/Hubert_Howe_Bancroft) | high | 13 |
| [San Andreas Lake](https://en.wikipedia.org/wiki/San_Andreas_Lake) | high | 13 |
| [Shoreline Amphitheatre](https://en.wikipedia.org/wiki/Shoreline_Amphitheatre) | high | 13 |
| [The Geysers](https://en.wikipedia.org/wiki/The_Geysers) | high | 13 |
| [UCSF Benioff Children's Hospital](https://en.wikipedia.org/wiki/UCSF_Benioff_Children's_Hospital) | high | 13 |
| [2012 San Francisco Giants season](https://en.wikipedia.org/wiki/2012_San_Francisco_Giants_season) | high | 12 |
| [Cody's Books](https://en.wikipedia.org/wiki/Cody's_Books) | high | 12 |
| [David Brower](https://en.wikipedia.org/wiki/David_Brower) | high | 12 |
| [Francis K. Shattuck](https://en.wikipedia.org/wiki/Francis_K._Shattuck) | high | 12 |
| [2018 San Francisco mayoral special election](https://en.wikipedia.org/wiki/2018_San_Francisco_mayoral_special_election) | high | 11 |
| [Amador Valley High School](https://en.wikipedia.org/wiki/Amador_Valley_High_School) | high | 11 |
| [Cosco Busan oil spill](https://en.wikipedia.org/wiki/Cosco_Busan_oil_spill) | high | 11 |
| [Nicholas C. Petris](https://en.wikipedia.org/wiki/Nicholas_C._Petris) | high | 11 |
| [Port of Redwood City](https://en.wikipedia.org/wiki/Port_of_Redwood_City) | high | 11 |
| [Port of Richmond (California)](https://en.wikipedia.org/wiki/Port_of_Richmond_(California)) | high | 11 |
| [1972 Oakland Athletics season](https://en.wikipedia.org/wiki/1972_Oakland_Athletics_season) | high | 10 |
| [Balmy Alley](https://en.wikipedia.org/wiki/Balmy_Alley) | high | 10 |
| [David Freiberg](https://en.wikipedia.org/wiki/David_Freiberg) | high | 10 |
| [Edwin Meese](https://en.wikipedia.org/wiki/Edwin_Meese) | high | 10 |
| [Harry Bridges](https://en.wikipedia.org/wiki/Harry_Bridges) | high | 10 |
| [Mass media in the San Francisco Bay Area](https://en.wikipedia.org/wiki/Mass_media_in_the_San_Francisco_Bay_Area) | high | 10 |
| [Port Chicago disaster](https://en.wikipedia.org/wiki/Port_Chicago_disaster) | high | 10 |
| [Space Sciences Laboratory](https://en.wikipedia.org/wiki/Space_Sciences_Laboratory) | high | 10 |
| [The Argonaut](https://en.wikipedia.org/wiki/The_Argonaut) | high | 10 |
| [Tom McEnery](https://en.wikipedia.org/wiki/Tom_McEnery) | high | 10 |
| [Treaty of San Francisco](https://en.wikipedia.org/wiki/Treaty_of_San_Francisco) | high | 10 |
| [Henry Durant](https://en.wikipedia.org/wiki/Henry_Durant) | high | 9 |
| [History of Bay Area Rapid Transit](https://en.wikipedia.org/wiki/History_of_Bay_Area_Rapid_Transit) | high | 9 |
| [Jared Huffman](https://en.wikipedia.org/wiki/Jared_Huffman) | top | 9 |
| [McKesson Corporation](https://en.wikipedia.org/wiki/McKesson_Corporation) | high | 9 |
| [The Valley of the Moon (novel)](https://en.wikipedia.org/wiki/The_Valley_of_the_Moon_(novel)) | high | 9 |
| [Flower Drum Song](https://en.wikipedia.org/wiki/Flower_Drum_Song) | high | 8 |
| [Hearst family](https://en.wikipedia.org/wiki/Hearst_family) | high | 8 |
| [Hydrography of the San Francisco Bay Area](https://en.wikipedia.org/wiki/Hydrography_of_the_San_Francisco_Bay_Area) | high | 8 |
| [Joseph LeConte](https://en.wikipedia.org/wiki/Joseph_LeConte) | high | 8 |
| [Mike Grgich](https://en.wikipedia.org/wiki/Mike_Grgich) | high | 8 |
| [Owen Chamberlain](https://en.wikipedia.org/wiki/Owen_Chamberlain) | high | 8 |
| [Pacific Telesis](https://en.wikipedia.org/wiki/Pacific_Telesis) | high | 8 |
| [Paul Masson](https://en.wikipedia.org/wiki/Paul_Masson) | high | 8 |
| [Pierre Salinger](https://en.wikipedia.org/wiki/Pierre_Salinger) | high | 8 |
| [Daniel Coit Gilman](https://en.wikipedia.org/wiki/Daniel_Coit_Gilman) | high | 7 |
| [Joseph Strauss (engineer)](https://en.wikipedia.org/wiki/Joseph_Strauss_(engineer)) | high | 7 |
| [Ray Dolby](https://en.wikipedia.org/wiki/Ray_Dolby) | high | 7 |
| [San Francisco Marathon](https://en.wikipedia.org/wiki/San_Francisco_Marathon) | high | 7 |
| [See's Candies](https://en.wikipedia.org/wiki/See's_Candies) | high | 7 |
| [Sports in the San Francisco Bay Area](https://en.wikipedia.org/wiki/Sports_in_the_San_Francisco_Bay_Area) | top | 7 |
| [Suisun Marsh](https://en.wikipedia.org/wiki/Suisun_Marsh) | high | 7 |
| [Walter Shorenstein](https://en.wikipedia.org/wiki/Walter_Shorenstein) | high | 7 |
| [1958 San Francisco Giants season](https://en.wikipedia.org/wiki/1958_San_Francisco_Giants_season) | high | 6 |
| [Don Sherwood (DJ)](https://en.wikipedia.org/wiki/Don_Sherwood_(DJ)) | high | 6 |
| [Mantra-Rock Dance](https://en.wikipedia.org/wiki/Mantra-Rock_Dance) | high | 6 |
| [Paul Avery](https://en.wikipedia.org/wiki/Paul_Avery) | high | 6 |
| [San Francisco Bay Discovery Site](https://en.wikipedia.org/wiki/San_Francisco_Bay_Discovery_Site) | high | 6 |
| [Transportation in the San Francisco Bay Area](https://en.wikipedia.org/wiki/Transportation_in_the_San_Francisco_Bay_Area) | top | 6 |
| [101 California Street](https://en.wikipedia.org/wiki/101_California_Street) | high | 5 |
| [Alvinza Hayward](https://en.wikipedia.org/wiki/Alvinza_Hayward) | high | 5 |
| [Año Nuevo Island](https://en.wikipedia.org/wiki/A%C3%B1o_Nuevo_Island) | high | 5 |
| [Culture of San Francisco](https://en.wikipedia.org/wiki/Culture_of_San_Francisco) | high | 5 |
| [Cyril Magnin](https://en.wikipedia.org/wiki/Cyril_Magnin) | high | 5 |
| [Gulf of the Farallones](https://en.wikipedia.org/wiki/Gulf_of_the_Farallones) | high | 5 |
| [History of California wine](https://en.wikipedia.org/wiki/History_of_California_wine) | high | 5 |
| [History of the Jews in San Francisco](https://en.wikipedia.org/wiki/History_of_the_Jews_in_San_Francisco) | high | 5 |
| [Jimmy McCracklin](https://en.wikipedia.org/wiki/Jimmy_McCracklin) | high | 5 |
| [Joseph James DeAngelo](https://en.wikipedia.org/wiki/Joseph_James_DeAngelo) | high | 5 |
| [Matthew Turner (shipbuilder)](https://en.wikipedia.org/wiki/Matthew_Turner_(shipbuilder)) | high | 5 |
| [Michael Shellenberger](https://en.wikipedia.org/wiki/Michael_Shellenberger) | high | 5 |
| [Netflix, Inc.](https://en.wikipedia.org/wiki/Netflix%2C_Inc.) | high | 5 |
| [Ollie Johnston](https://en.wikipedia.org/wiki/Ollie_Johnston) | high | 5 |
| [Spreckels family](https://en.wikipedia.org/wiki/Spreckels_family) | high | 5 |
| [Vincent DeDomenico](https://en.wikipedia.org/wiki/Vincent_DeDomenico) | high | 5 |
| [Walter J. Haas](https://en.wikipedia.org/wiki/Walter_J._Haas) | high | 5 |
| [Bob Wilkins](https://en.wikipedia.org/wiki/Bob_Wilkins) | high | 4 |
| [Fleet and Industrial Supply Center, Oakland](https://en.wikipedia.org/wiki/Fleet_and_Industrial_Supply_Center%2C_Oakland) | high | 4 |
| [William Penn Mott Jr.](https://en.wikipedia.org/wiki/William_Penn_Mott_Jr.) | high | 4 |
| [YWCA Building (Oakland, California)](https://en.wikipedia.org/wiki/YWCA_Building_(Oakland%2C_California)) | high | 4 |
| [2015 San Francisco mayoral election](https://en.wikipedia.org/wiki/2015_San_Francisco_mayoral_election) | high | 3 |
| [2019 San Francisco mayoral election](https://en.wikipedia.org/wiki/2019_San_Francisco_mayoral_election) | high | 3 |
| [Anne Gust Brown](https://en.wikipedia.org/wiki/Anne_Gust_Brown) | high | 3 |
| [Art in the San Francisco Bay Area](https://en.wikipedia.org/wiki/Art_in_the_San_Francisco_Bay_Area) | high | 3 |
| [Black Bear Ranch](https://en.wikipedia.org/wiki/Black_Bear_Ranch) | high | 3 |
| [Carey Perloff](https://en.wikipedia.org/wiki/Carey_Perloff) | high | 3 |
| [Concannon Vineyard](https://en.wikipedia.org/wiki/Concannon_Vineyard) | high | 3 |
| [Food First](https://en.wikipedia.org/wiki/Food_First) | top | 3 |
| [Japanese YWCA Building](https://en.wikipedia.org/wiki/Japanese_YWCA_Building) | high | 3 |
| [Mechanics Bank](https://en.wikipedia.org/wiki/Mechanics_Bank) | high | 3 |
| [Mervyn Silverman](https://en.wikipedia.org/wiki/Mervyn_Silverman) | high | 3 |
| [Oceanwide Center, San Francisco](https://en.wikipedia.org/wiki/Oceanwide_Center%2C_San_Francisco) | high | 3 |
| [Serranus Clinton Hastings](https://en.wikipedia.org/wiki/Serranus_Clinton_Hastings) | high | 3 |
| [Demographics of San Francisco](https://en.wikipedia.org/wiki/Demographics_of_San_Francisco) | high | 2 |
| [Ecology of the San Francisco Estuary](https://en.wikipedia.org/wiki/Ecology_of_the_San_Francisco_Estuary) | high | 2 |
| [Josephine Tychson](https://en.wikipedia.org/wiki/Josephine_Tychson) | high | 2 |
| [Kidnapping of Jaycee Dugard](https://en.wikipedia.org/wiki/Kidnapping_of_Jaycee_Dugard) | high | 2 |
| [Tim D. White](https://en.wikipedia.org/wiki/Tim_D._White) | high | 2 |
| [Twitter under Elon Musk](https://en.wikipedia.org/wiki/Twitter_under_Elon_Musk) | high | 2 |
| [Women in the California gold rush](https://en.wikipedia.org/wiki/Women_in_the_California_gold_rush) | high | 2 |
| [History of Santa Clara County, California](https://en.wikipedia.org/wiki/History_of_Santa_Clara_County%2C_California) | high | 1 |
| [Mayoralty of Gavin Newsom](https://en.wikipedia.org/wiki/Mayoralty_of_Gavin_Newsom) | high | 1 |
| [Metropolitan Club (San Francisco)](https://en.wikipedia.org/wiki/Metropolitan_Club_(San_Francisco)) | high | 1 |
| [Oakland Seaport](https://en.wikipedia.org/wiki/Oakland_Seaport) | top | 1 |
| [Sainte Claire Club](https://en.wikipedia.org/wiki/Sainte_Claire_Club) | high | 1 |
| [Seres Auto](https://en.wikipedia.org/wiki/Seres_Auto) | high | 1 |
| [Steven Weinberg](https://en.wikipedia.org/wiki/Steven_Weinberg) | high | 1 |
| [The Laundry SF](https://en.wikipedia.org/wiki/The_Laundry_SF) | high | 1 |
| [History of San Francisco State University](https://en.wikipedia.org/wiki/History_of_San_Francisco_State_University) | top | 0 |
| [Hughes Entertainment](https://en.wikipedia.org/wiki/Hughes_Entertainment) | high | 0 |
| [Memnon (clipper)](https://en.wikipedia.org/wiki/Memnon_(clipper)) | high | 0 |
| [Politics in the San Francisco Bay Area](https://en.wikipedia.org/wiki/Politics_in_the_San_Francisco_Bay_Area) | high | 0 |
| [San Francisco in the 1970s](https://en.wikipedia.org/wiki/San_Francisco_in_the_1970s) | high | 0 |
