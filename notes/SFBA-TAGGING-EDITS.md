# SFBA task force tagging edits (for Louie to apply on-wiki)

Goal: make the dynamic watchlist (PageAssessments project `California/San Francisco Bay Area task force`)
cover everything the bot historically watched, so the hard-coded config list can be dropped.

Method: 45 unique enwiki articles extracted from @sfedits post history, checked against
PageAssessments **with `pasubprojects=true`** (without it, task-force tags are invisible —
this bug produced an earlier false conclusion that nothing was tagged).

Banner syntax (from Talk:London Breed): `{{WikiProject California |importance=low |sfba=yes |sfba-importance=High}}`

## 1. Untagged articles (3) — add tags

| Talk page | Edit | Suggested |
|---|---|---|
| Talk:Chyanne Chen | add `\|sfba=yes \|sfba-importance=Mid` to existing {{WikiProject California}} | sitting supervisor |
| Talk:Manohar Raju | add `{{WikiProject California \|importance=Low \|sfba=yes \|sfba-importance=Mid}}` | SF Public Defender |
| Talk:Myrna Melgar | add `{{WikiProject California \|importance=Low \|sfba=yes \|sfba-importance=Mid}}` | sitting supervisor |

## 2. Unassessed (sfba-importance missing → "Unknown") (10) — fill in

All have `sfba=yes` already; add `|sfba-importance=` value:

| Talk page | Suggested | Rationale |
|---|---|---|
| Talk:Shamann Walton | Mid | supervisor, former board president |
| Talk:Rafael Mandelman | Mid | supervisor, current board president |
| Talk:Dean Preston | Mid | former supervisor |
| Talk:Connie Chan (politician) | Mid | sitting supervisor |
| Talk:Jackie Fielder | Mid | sitting supervisor |
| Talk:Brooke Jenkins | Mid | District Attorney |
| Talk:Alan Wong (politician) | Low–Mid | community college board / supervisor? verify |
| Talk:Beya Alcaraz | Low | verify current role |
| Talk:San Francisco Department of Public Works corruption scandal | Mid | major civic scandal |
| Talk:San Francisco Public Defender's Office | Mid | citywide office |

## 3. Arguably miscalibrated (Louie's editorial call)

| Talk page | Current | Suggested | Rationale |
|---|---|---|---|
| Talk:Daniel Lurie | Low | **High** | sitting mayor (Breed, former mayor, is High) |
| Talk:Scott Wiener | Low | Mid | state senator, SF-centric |
| Talk:Matt Haney | Low | Mid | assemblymember |
| Talk:David Chiu (politician) | Low | Mid | City Attorney |
| Talk:Bilal Mahmood | Low | Mid | sitting supervisor |
| Talk:Joel Engardio | Low | Mid | supervisor (recalled 2025 — Low defensible) |

## Already fine (pass Top+High today)

Gavin Newsom (Top); London Breed, Dianne Feinstein, George Moscone, Government of San Francisco,
Mayor of San Francisco, Members of the San Francisco Board of Supervisors, San Francisco Board of
Supervisors, Willie Brown (High).

## Resulting bot config (after edits)

- Wiki-etiquette note: fill importance honestly, not to fit the bot. If sitting supervisors are
  Mid (defensible), the **bot filter should be `["Top","High","Mid"]`** — that's ~2,450 articles
  (~50–120 edits/day): fine for Discord, heavy for Bluesky.
- Option: two accounts in config — Bluesky/Mastodon account with `["Top","High"]` (~503 articles),
  Discord-only account with `["Top","High","Mid"]`. The accounts array already supports this.
- Full history coverage check after edits: rerun the gap script
  (scratchpad/gap-analysis.json has the raw per-article data as of 2026-07-13).
