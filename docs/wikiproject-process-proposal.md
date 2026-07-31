# Draft: regenerating the SFBA task force priority list

Status: **draft for on-wiki posting, not yet posted**
Prepared: 2026-07-31
Target: `Wikipedia talk:WikiProject California/San Francisco Bay Area task force`

Continues the "Data-assisted importance review" thread opened 2026-07-22, which
stalled on a navbox objection from Pi.1415926535 — since investigated and fixed.

Written in Louie's voice for an editor audience. Evidence and full working:
[`importance-ranking-methodology.md`](importance-ranking-methodology.md).
All figures from the 2026-07-31 run.

---

## 1. Why I'm posting this

I run [@sfedits](https://bsky.app/profile/sfedits.bsky.social), a bot that posts
images of edits to Bay Area articles. It picks what to watch from our importance
ratings — currently everything rated Top or High, about 500 articles.

I should say up front that I've only been active in this task force for about a
week, so I'm coming at this as a newcomer with a bot rather than as someone who has
been maintaining these ratings. After watching the bot's output for a while, enough
of it looked odd that I went and checked the ratings rather than the code.

What I found is that our ratings aren't so much wrong as **unevenly maintained**.
Some parts of the region have been assessed carefully; others have barely been
touched since the criteria were written in 2007. That isn't a criticism of anyone —
14,000 articles is more than any small group can keep current by hand, and
assessment backlogs are endemic across Wikipedia. But the list has drifted, and I'd
rather show my working than quietly point my bot somewhere else.

One question first: **I couldn't find a written scope statement for this task
force.** Our stub templates cover twelve counties, including Monterey, San Benito
and Santa Cruz, while ABAG's standard definition of the Bay Area is nine. I've
assumed nine throughout. If that's wrong, please say so, because it changes
everything below.

---

## 2. What I found

Our ratings look reasonable one at a time. The problem shows up when you put them
side by side.

### Two articles, both currently rated

| Article | Links from other Bay Area articles | Rating |
|---|---|---|
| **Oakland Raiders** — NFL franchise, 1960–2019 | **200** | **Low** |
| **Food First** — food-policy nonprofit in Oakland | **3** | **Top** |

Food First is a perfectly good article and someone was right to write it. The point
isn't that its rating is wrong — it's that these two can't both be right at the same
time.

### A few more of the same shape

Rated below where their prominence sits:

| Article | Links | Rating |
|---|---|---|
| Stanford, California | 434 | Low |
| Mission District, San Francisco | 317 | Mid |
| Market Street, San Francisco | 225 | Mid |
| **Ohlone** — the Bay Area's indigenous people, Good Article | **221** | **Mid** |
| Oracle Park | 210 | Mid |
| Candlestick Park | 206 | Mid |

And rated Top:

| Article | Links |
|---|---|
| Jared Huffman | 10 |
| Food First | 3 |
| History of San Francisco State University | 0 |

Ohlone is the one that bothers me most. The indigenous people of this region, a
Good Article, linked from 221 other Bay Area articles — rated Mid.

### Our own rule, applied unevenly

Our assessment page says High includes *"county seats (not already in the Top
list)."* Six of the nine follow it. Three don't:

| County | Seat | Links | Rating |
|---|---|---|---|
| Contra Costa | Martinez | 140 | Mid |
| San Mateo | Redwood City | 321 | Mid |
| Solano | Fairfield | 102 | Mid |

### What it adds up to

Taking the 25 most-linked rated articles for each place and counting how many are
Top or High:

| San Francisco | Oakland | Berkeley | San Jose | Solano |
|---|---|---|---|---|
| 21 of 25 | 13 of 25 | 11 of 25 | 6 of 25 | 1 of 25 |

I want to be careful with this one. It is **not** evidence that anyone deliberately
neglected a region — the individual examples above run in both directions across the
whole Bay Area. It's the aggregate symptom of ratings that were never calibrated
against each other. But the practical effect is real: anything built from Top and
High, as my bot is, gets much thinner coverage of the South Bay and Solano.

None of this is anyone's fault. These ratings were made article by article, by
different people, over about nineteen years, without a shared reference for what
High means across the region. That's a coordination problem, and it's the kind of
thing that's fixable.

---

## 3. How I'd regenerate the list

### What gets counted

**How many other Bay Area articles link to this one, in prose an editor actually
wrote.**

That last clause is doing a lot of work. Most links on Wikipedia exist for reasons
that have nothing to do with an editor judging two subjects related, and I had to
strip several kinds out before the numbers meant anything:

| Kind of link | Why it exists | Share |
|---|---|---|
| Navbox and template | every BART station links every other because they share a template | **77% of all links** |
| Citation | `{{cite web \|work=[[TechCrunch]]}}` names a source | ~93% of TechCrunch's |
| Redirect | `[[California Gold Rush]]` and `[[California gold rush]]` are the same act | 14% of edges |

What's left is the thing worth counting: an editor decided these two subjects belong
connected.

**One I know about and haven't fixed:** infobox fields that list values
(`operating system = {{hlist|[[iOS]]|[[Android]]}}`) still count. This mostly
affects technology products, which are somewhat over-ranked as a result. It's a
known defect, not a surprise waiting to happen.

### Why this measure

Because it agrees with what we have collectively already decided, better than
anything else I tried. Grouping every rated article by its current tier:

| Current rating | Median incoming links |
|---|---|
| Top | 236 |
| High | 36 |
| Mid | 10 |
| Low | 3 |

A clean gradient across ~11,800 ratings made by many people over nineteen years.

I want to be explicit about why this isn't circular, given §2 argued our ratings are
inconsistent. Individually they are. Collectively they still encode a real shared
sense of what matters here, and that sense tracks how densely an article is woven
into the region's coverage. The measure doesn't replace our judgement — it takes the
judgement we've expressed 11,800 times and applies it evenly, which is the part
nobody can do by hand at this scale.

### What I deliberately don't count

- **Pageviews.** Barely improve agreement once links are counted, and they measure
  readership rather than centrality — a different standard, and not one I wanted to
  impose silently. Views are published alongside every article so anyone can argue
  specific cases.
- **Number of other WikiProjects.** I expected articles only we tag to be more
  Bay-Area-specific. The opposite is true: important topics attract *more* projects.
- **Wikidata statement counts, and whether the lead names a place.** Both add
  essentially nothing once links are counted.

### Which articles are eligible

Everything currently tagged, plus articles Wikidata places in the nine ABAG counties
— but only where the data says the subject **is** here (*located in*,
*headquartered in*, *located at*, *holds a Bay Area public office*), not merely that
a person was born, died, or once worked here.

That distinction removes about 10,900 of 15,500 raw candidates. Ronald Reagan
qualifies on "worked here" because he served at Fort Mason; Microsoft qualifies
because it has a Silicon Valley campus. Both true, neither a Bay Area topic. It also
matches what our criteria already say — that Low includes *"biographies of people or
bands originally from the SFBA that are not well connected to it."*

**Universe: 18,474 articles** — 14,404 already tagged, 4,070 candidates.

---

## 4. What a regenerated list would look like

### Proposed tiers

Tier *sizes* are a judgement call the data cannot make. This is a proposal, and it's
the part I'd most like argued with:

| Tier | Share | Articles | Link cutoff | vs today |
|---|---|---|---|---|
| Top | 0.37% | 68 | ≥239 | same as today's 68 |
| High | 2.5% | 394 | ≥58 | today's 438 |
| Mid | 15% | 2,309 | ≥11 | today's 1,949 |
| Low | rest | 15,703 | | |

I chose the Top cut to match our current Top exactly — 68 articles — for two
reasons. It keeps the proposal about *which* articles are Top rather than *how
many*, and a tighter cut starts dropping things our own criteria name as Top. At
0.25% the Golden Gate Bridge falls out of the top tier, along with the 1989 Loma
Prieta earthquake, Napa County, Solano County and the Presidio. That seemed like the
wrong error to make.

### Effect on existing ratings

| | |
|---|---|
| Unchanged | **9,156 (78%)** |
| Promoted | 1,286 |
| Demoted | 1,361 |
| Currently unassessed, would get a rating | 2,601 |

Four articles in five keep the rating they have. This isn't a proposal to overturn
the list; it's a proposal to make the fifth one consistent with the rest.

### Newly tagged

4,070 articles would gain a task force tag. **3,845 of them at Low**, where a wrong
tag costs almost nothing. 204 at Mid, and **21 at Top or High** — small enough to
review by hand, and I think that review is genuinely needed:

```
241  top   University of California, Davis      101  high  Internet Archive
183  high  U.S. Route 101 in California          94  high  Ninth Circuit Court of Appeals
177  high  Western Assoc. of Schools & Colleges  93  high  El Camino Real (California)
159  high  California State Route 1              75  high  Port of Oakland
152  high  California county routes in zone G    67  high  California State Route 123
138  high  Interstate 80 in California           67  high  Regents of the Univ. of California
120  high  Interstate 580 (California)           64  high  San Pablo, California
118  high  Neighborhoods in San Francisco        63  high  State Bar of California
104  high  Sierra Club                           62  high  California State Route 84
                                                 62  high  VMware
                                                 61  high  Yountville, California
                                                 59  high  Cox Stadium
```

Some are clearly ours — San Pablo and Yountville are Bay Area towns, Internet
Archive is headquartered in the Richmond District, VMware is in Palo Alto, Port of
Oakland is the successor to an article we already rate Top.

Others are genuinely arguable. **Eight of the 21 are long state highways** that
qualify because they cross Bay Area counties, and several are statewide bodies that
happen to be headquartered here. **I don't think I should decide those alone.** A
rule excluding linear features that cross many counties would be easy to write, but
that's a scope decision, not a technical one — and it's exactly the sort of thing
worth agreeing before it's applied.

---

## 5. What this gets wrong, and what to do about it

A ranking like this has failure modes. I'd rather name them with the fix than have
them found later.

### A low score can mean the article is orphaned, not unimportant

**Oakland Seaport** is rated Top and has 2 incoming links. That looks like a
demotion candidate. It isn't. In June 2024 an editor correctly split the port
*authority* out of the *facility*, creating **Port of Oakland** — and since everyone
writes `[[Port of Oakland]]`, the links followed the new article, which carries no
task force tag at all. We're rating the wrong article.

**The signature is detectable**: near-zero editorial links but a high total backlink
count. That's a rename or split, not insignificance, and the remedy is to fix the
tagging, not to demote. Any demote list should separate the two before anyone acts
on it. I haven't yet swept for others.

### A low score can mean the encyclopedia is missing links

The **Assassinations of George Moscone and Harvey Milk** article is linked from 332
pages — but 218 articles mention the event, and **122 of those mention it without
linking it**, including Jonestown, Jim Jones, Peoples Temple in San Francisco, and
Government of San Francisco.

Where that's the case, the fix is to add the links, not to override the number.
That's ordinary editing that improves the encyclopedia and happens to improve the
measurement too.

I should be honest that I've only measured this for one article. I strongly suspect
it generalises, but validating it properly across the region is a lot of work I
haven't done.

### Our criteria contain two definitions of importance

The preamble on our assessment page defines importance as *"the probability of the
average reader needing to look up the topic"* — that's readership. Wikidemo's third
rating question asks *"how important is knowing this subject to a comprehensive,
balanced understanding of the BA"* — that's centrality.

They give opposite answers. The **Zodiac Killer** gets 2.2 million views a year and
comparatively few links. Crime articles generally are read heavily and linked
rarely.

I've ranked on centrality because it matches what we've actually done in practice,
and published view counts alongside so the other case can be made. But this is a
real fork in the road and it's the project's to choose, not mine.

### There are probably more kinds of link I haven't stripped

I found four — navbox, citation, redirect, and infobox specification lists — and
each only became visible after fixing the previous one. Succession boxes, coordinate
templates, `{{main}}` hatnotes: all plausible, none measured.

The question to ask of any number here is *"what would make this large for a reason
unrelated to importance?"* If you can think of one I've missed, that's a bug worth
reporting, and it's the most useful thing anyone could do with this.

---

## 6. What I'm doing, and what I'm asking

**What I'm doing regardless:** pointing my bot at the top 500 of this ranking
instead of at Top+High. That's an operator's choice about my own bot, it needs no
consensus, and it's reversible. It changes 287 articles in and 293 out, at roughly
the same posting volume. If the coverage looks wrong to you, that's useful feedback
and I'll adjust.

**What I'm asking:**

1. **Is our scope nine counties or twelve?**
2. **Do the tier cuts look right?** 68 Top and 394 High, or different?
3. **Are the 21 proposed new Top/High articles ours?** Particularly the state
   highways.
4. **Anything obviously wrong in the ranking?** Every number is reproducible and I'll
   publish the data.

**What I'm not proposing:** that anyone bot-apply 1,286 promotions and 1,361
demotions to talk pages. That's a much bigger conversation, and there is essentially
no precedent for a bot changing importance ratings — the one request that proposed
it was declined as too broad. What I'd suggest instead is starting with the parts
that are uncontroversial: the three county seats, the articles nobody has tagged, and
the clearly-orphaned ones — and seeing how that goes.

---

## Notes for Louie, not for posting

- **Publish the data somewhere reachable** before posting — §6 promises it. Options:
  a task force subpage, a Toolforge URL, or a gist. `ranking.json` is ~2 MB.
- **The 25-most-linked table in §2** attributes articles to cities using the first
  Bay Area place name in the lead, which is a proxy. Redo via Wikidata `P131` before
  posting, or a South Bay editor will reasonably ask how articles were assigned.
- **Infobox links are still counted** (§3 says so). If LUI-99/LUI-95 land first,
  regenerate and drop that caveat.
- **Post the scope question first**, separately and early — the answer changes the
  universe, and asking it on its own reads as collaborative rather than as a caveat
  buried in a long proposal.
