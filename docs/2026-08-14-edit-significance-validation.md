# Edit-Significance Classifier Validation Report

**Date:** 2026-08-14

**Purpose:** Measure `lib/edit-significance.js` `classifyEdit()` against mwedittypes labels across three cohorts. This is Phase 2's go/no-go gate: of the edits mwedittypes labels prose-touching (Word/Sentence/Paragraph/Character), ≥95% per cohort must classify substantive. The reverse bucket (we-say-substantive, no prose mwedittypes key) is characterized only, not gated.

---

## Cohort Summaries

### SFBA (San Francisco Bay Area top-500)

Wikipedia articles tagged with San Francisco Bay Area task-force designation, sampled from en.wikipedia.org.

| Metric | Value |
|--------|-------|
| Edits compared | 1219 |
| Prose-labeled (mwedittypes) | 690 |
| Caught (our classifier) | 682 |
| **Caught %** | **98.8%** |
| **GATE** | **✓ PASS** (682/690 ≥ 95%) |
| Both-not-substantive | 284 |

We-say-substantive-only breakdown (245 total):
- Carry mwedittypes Reference/Media/Heading/Table: **134** (expected by design)
- Carry only Template: **110** (expected when wtf_wikipedia renders template into infobox values/prose)
- Carry neither: **1** (requires review)

**Missed-prose: 8 entries**, each reviewed against its diff below. All eight are whitespace, paragraph-reflow, or link-markup changes with rendered wording unchanged.

---

### Enwiki-Random (1500 recent-window sample)

Recent-window sample across 30 days of en.wikipedia.org mainspace human edits (non-bot, non-minor). Slice-per-23-hour strategy ensures time-of-day and day-of-week distribution.

| Metric | Value |
|--------|-------|
| Edits harvested | 1500 |
| Skipped (missing/error) | 5 |
| Edits compared | 1495 |
| Prose-labeled (mwedittypes) | 755 |
| Caught (our classifier) | 743 |
| **Caught %** | **98.4%** |
| **GATE** | **✓ PASS** (743/755 ≥ 95%) |
| Both-not-substantive | 449 |

We-say-substantive-only breakdown (291 total):
- Carry mwedittypes Reference/Media/Heading/Table: **170** (expected by design)
- Carry only Template: **121** (expected when wtf_wikipedia renders template)
- Carry neither: **0** (no problematic cases)

**Missed-prose: 12 entries**, each reviewed against its diff below. Eight are whitespace/reflow or link-markup changes with rendered wording unchanged; four carry reader-visible changes rendered through templates, which the ignored template-bag channel reports and the template policy deliberately drops (detailed per entry).

---

### Eswiki-Random (1000 recent-window sample)

Recent-window sample across 30 days of es.wikipedia.org mainspace human edits (non-bot, non-minor), labeled with lang='es' for mwedittypes.

| Metric | Value |
|--------|-------|
| Edits harvested | 1000 |
| Skipped (missing/error) | 3 |
| Edits compared | 997 |
| Prose-labeled (mwedittypes) | 561 |
| Caught (our classifier) | 554 |
| **Caught %** | **98.8%** |
| **GATE** | **✓ PASS** (554/561 ≥ 95%) |
| Both-not-substantive | 200 |

We-say-substantive-only breakdown (236 total):
- Carry mwedittypes Reference/Media/Heading/Table: **134** (expected by design)
- Carry only Template: **100** (expected when wtf_wikipedia renders template)
- Carry neither: **2** (requires review)

**Missed-prose: 7 entries**, each reviewed against its diff below. All seven are whitespace, paragraph-reflow, or link-markup changes with rendered wording unchanged.

---

## Per-Cohort Gate Verdicts

| Cohort | Prose-labeled | Caught | % | Status |
|--------|---------------|--------|----|----|
| SFBA | 690 | 682 | 98.8% | ✓ **PASS** |
| Enwiki-random | 755 | 743 | 98.4% | ✓ **PASS** |
| Eswiki-random | 561 | 554 | 98.8% | ✓ **PASS** |

Gate is directional only: measures false-negatives (prose we missed) exclusively. Reverse bucket (we-say-substantive, no prose keys) is expected and characterized above.

---

## Per-Channel Reference Recall

Secondary metric: for edits mwedittypes labels with Reference key, what share did our classifier catch with reasons including 'references'? This measures channel-level blindness the prose gate cannot detect (an edit may touch non-Reference prose, passing the gate, while References in the same edit go uncaught).

| Cohort | Reference-labeled (mwedittypes) | Caught with reasons=['references'] | % |
|--------|-----------------|--------|-------|
| SFBA | 321 | 298 | 92.8% |
| Enwiki-random | 315 | 282 | 89.5% |
| Eswiki-random | 176 | 150 | 85.2% |

The gap between the prose gate (98–99%) and reference recall (85.2–92.8%) has not
been systematically diagnosed: the 82 uncaught Reference-labeled edits
(23 SFBA + 33 enwiki + 26 eswiki) have not been classified one by one. Spot
checks during review found two contributing mechanisms: mwedittypes' Reference
key can fire on edits whose only change is prose near reference markup, and
changes confined to a ref's `name=` attribute are canonicalized away by design
(the attribute does not render; see `lib/edit-significance.js`). How much of
the gap each mechanism explains is not measured.

---

## Hand-Review of Disagreements

Every missed-prose entry (mwedittypes assigns a prose key, classifier returns
not-substantive) and every carry-neither entry is listed below. The heading,
label/verdict line, diff hunk, and divergence windows of each entry are
machine-generated by `scripts/analysis/edit-significance/render-disagreements.js`
from the cohort data (hunks are real `diff -u` output; lines are truncated at
220 characters, and whenever any line is truncated the full first-to-last
divergence window of each changed line pair is emitted alongside). Only the
**Diagnosis** line under each entry is written by a reviewer, and it may claim
only what the hunk and windows show.

### SFBA missed-prose (8 entries)

#### sfba 1367762716 — Google

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -128,9 +128,9 @@
 === Ad market ===
 Google's advertising revenue was challenged in 2006 by some advertisers decline to purchase display ads.<ref name="wsj-cookie">{{Cite web |last=Vascellaro |first=Jessica E. |date=10 August 2010 |title=Google Agonizes on …[line truncated]
 
-On March 11, 2008, Google acquired [[DoubleClick]] for $3.1&nbsp;billion, transferring to Google valuable relationships that DoubleClick had with Web publishers and advertising agencies.<ref>{{Cite news |last=Lawsky |fi …[line truncated]
+On March 11, 2008, Google acquired [[DoubleClick]] for $3.1&nbsp;billion, transferring to Google valuable relationships that DoubleClick had with Web publishers and advertising agencies.<ref>{{Cite news |last=Lawsky |fi …[line truncated]
 
-In May 2011, the number of monthly unique visitors to Google surpassed one billion for the first time.<ref>{{Cite news |last=Worstall |first=Tim |date=June 22, 2011 |title=Google Hits One Billion Visitors in Only One Mo …[line truncated]
+By 2011, Google was handling approximately 3 billion searches per day. To handle this workload, Google built 11 [[data centers]] around the world with several thousand servers in each. These data centers allowed Google  …[line truncated]
 
 === 2012 onwards ===
 [[File:Google-Deep Mind headquarters in London, 6 Pancras Square.jpg|thumb|upright|Entrance of building where Google and its subsidiary DeepMind are located at 6 Pancras Square, London]]


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …-date=March 9, 2017 |website=[[The New York Times]]}}</ref> By 2011, Google was handling approximately 3 billion searches per day. To handle this workload, Google built 11 [[data centers]] around the world with several thousand servers in each. These data centers allowed Google to handle the ever-changing workload more efficiently.<ref name="Google Inc" />
  + …-date=March 9, 2017 |website=[[The New York Times]]}}</ref> 
  pair 2:
  - In May 2011, the number of monthly unique visitors to Google…
  + By 2011, Google was handling approximately 3 billion searches per day. To handle this workload, Google built 11 [[data centers]] around the world with several thousand servers in each. These data centers allowed Google to handle the ever-changing workload more efficiently.<ref name="Google Inc" /> In May 2011, the number of monthly unique visitors to Google…
```

**Diagnosis:** A paragraph boundary moved: the "By 2011 …" sentence detaches from the end of the DoubleClick paragraph and opens the following one. Sentence order and wording are unchanged, so the whitespace-normalized prose is identical.

#### sfba 1368465656 — Napa Valley AVA

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -41,7 +41,9 @@
  |website      = JancisRobinson.com
  |access-date  = January 2, 2011
  |archive-date = April 4, 2014
- |archive-url  = https://web.archive.org/web/20140404102022/http://www.jancisrobinson.com/articles/a200808082.html}}</ref> Napa's viticulture history dates back to the nineteenth century,<ref>{{cite book
+ |archive-url  = https://web.archive.org/web/20140404102022/http://www.jancisrobinson.com/articles/a200808082.html}}</ref> 
+
+Napa's viticulture history dates back to the nineteenth century,<ref>{{cite book
  |title       = A Memorial and Biographical History of Northern California
  |url         = http://www.calarchives4u.com/history/history-napa.htm
  |access-date  = January 2, 2011
```

**Diagnosis:** Paragraph split: "Napa's viticulture history…" starts a new paragraph after the closing ref. No wording change.

#### sfba 1364896887 — U.S. Route 101 in California

label keys: Paragraph, Section, Sentence, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -121,7 +121,7 @@
 
 North of Hopland, US&nbsp;101 widens to a four-lane freeway as it approaches [[Ukiah, California|Ukiah]], where it intersects [[California State Route 253|SR&nbsp;253]] and [[California State Route 222|SR&nbsp;222]]. In …[line truncated]
 
-US&nbsp;101 intersects with [[California State Route 162|SR&nbsp;162]] north of Willits before reaching [[Laytonville]] inside Long Valley. US&nbsp;101 traverses the {{convert|1796|ft|m|adj=on}} [[Rattlesnake Summit]],< …[line truncated]
+US&nbsp;101 intersects with [[California State Route 162|SR&nbsp;162]] north of Willits before reaching [[Laytonville]] inside Long Valley. US&nbsp;101 traverses the {{convert|1796|ft|m|adj=on}} [[Rattlesnake Summit]],< …[line truncated]
 
 [[File:US101 along Eel River near Stafford.jpg|left|thumb|US 101 following the Eel River near Stafford]]
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …lifornia|Cummings]] and Legget, and Piercy and Cooks Valley; <ref name="google overview" /> these sections were the old a…
  + …lifornia|Cummings]] and Legget, and Piercy and Cooks Valley;<ref name="google overview" /> these sections were the old a…
```

**Diagnosis:** One space removed before a ref tag (`Valley; <ref` → `Valley;<ref`). Whitespace only.

#### sfba 1364982640 — EBay

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -75,7 +75,7 @@
 
 On May 28, 2003, in the case of ''[[eBay Inc. v. MercExchange, L.L.C.]]'', which had implications for the treatment of [[business method patent]]s, a [[United States district court]] jury found eBay guilty of willful pa …[line truncated]
 
-In 2003, eBay sought to develop its [[E-commerce in China|e-commerce business in China]], acquiring the country's leading online auction platform (EachNet) and reaching an 85% market share.<ref name=":Liu">{{Cite book | …[line truncated]
+In 2003, eBay sought to develop its [[E-commerce in China|e-commerce business in China]], acquiring the country's leading online auction platform (EachNet) and reaching an 85% market share.<ref name=":Liu">{{Cite book | …[line truncated]
 
 In August 2004, eBay acquired 25% of the [[classified advertising]] website [[Craigslist]] from former Craigslist executive Phillip Knowlton for $32 million.<ref>{{Cite news |url=https://www.nytimes.com/2004/08/14/busin …[line truncated]
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …rchive-date=February 13, 2026 |website=Campaign Asia}}</ref> ''' '''Reasons that contributed to eBay pulling out of China included the free-versus-paid model.<ref>{{Cite web |title=Rivals Taobao, eBay clash on whether fr …[window truncated]… w.wsj.com/articles/SB116647579560853680 |archive-date=January 14, 2024 |access-date=2026-03-17 |work=Wall Street Journal |language=en-US |issn=0099-9660}}</ref>eBay had a paid platform, which included platform fees and l…
  + …rchive-date=February 13, 2026 |website=Campaign Asia}}</ref>''' '''Reasons that contributed to eBay pulling out of China included the free-versus-paid model.<ref>{{Cite web |title=Rivals Taobao, eBay clash on whether fre …[window truncated]… .wsj.com/articles/SB116647579560853680 |archive-date=January 14, 2024 |access-date=2026-03-17 |work=Wall Street Journal |language=en-US |issn=0099-9660}}</ref> eBay had a paid platform, which included platform fees and l…
```

**Diagnosis:** Spacing shuffled around ref tags (`</ref> '''` → `</ref>'''`, `</ref> <ref>` → `</ref><ref>`, `</ref>eBay` → `</ref> eBay`). Rendered text unchanged.

#### sfba 1364982429 — EBay

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -75,7 +75,7 @@
 
 On May 28, 2003, in the case of ''[[eBay Inc. v. MercExchange, L.L.C.]]'', which had implications for the treatment of [[business method patent]]s, a [[United States district court]] jury found eBay guilty of willful pa …[line truncated]
 
-In 2003, eBay sought to develop its [[E-commerce in China|e-commerce business in China]], acquiring the country's leading online auction platform (EachNet) and reaching an 85% market share.<ref name=":Liu">{{Cite book | …[line truncated]
+In 2003, eBay sought to develop its [[E-commerce in China|e-commerce business in China]], acquiring the country's leading online auction platform (EachNet) and reaching an 85% market share.<ref name=":Liu">{{Cite book | …[line truncated]
 
 In August 2004, eBay acquired 25% of the [[classified advertising]] website [[Craigslist]] from former Craigslist executive Phillip Knowlton for $32 million.<ref>{{Cite news |url=https://www.nytimes.com/2004/08/14/busin …[line truncated]
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …cess-date=February 26, 2024 |work=[[Bloomberg News]]}}</ref> <ref>{{Cite web |last=Coonan |first=Clifford |date=2006-12-2…
  + …cess-date=February 26, 2024 |work=[[Bloomberg News]]}}</ref><ref>{{Cite web |last=Coonan |first=Clifford |date=2006-12-2…
```

**Diagnosis:** A space between two adjacent refs removed (`</ref> <ref>` → `</ref><ref>`). Whitespace only.

#### sfba 1366879652 — Nancy Pelosi

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -326,7 +326,7 @@
 == Public image ==
 Pelosi has often been described as a polarizing figure, facing criticism from both the political right and left. [[Progressivism in the United States|Progressives]] have criticized her for her knowledge of [[waterboardi …[line truncated]
 
-Pelosi has faced allegations of using her position for [[insider trading]], particularly concerning stock transactions that critics claim were influenced by her legislative knowledge.<ref>{{Cite web |date=2024-06-06 |ti …[line truncated]
+Pelosi has faced allegations of using her position for [[insider trading]], particularly concerning stock transactions that critics claim were influenced by her legislative knowledge.<ref>{{Cite web |date=2024-06-06 |ti …[line truncated]
 
 ==Electoral history==
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …6.html}}</ref> This rate of retrun beat the S&P 500 by 589%. <ref name=":1" /> Critics have also depicted her as a symbol…
  + …6.html}}</ref> This rate of retrun beat the S&P 500 by 589%.<ref name=":1" /> Critics have also depicted her as a symbol…
```

**Diagnosis:** A space before a ref removed (`589%. <ref` → `589%.<ref`). Whitespace only.

#### sfba 1367052786 — Angel Island (California)

label keys: Paragraph, Section, Template, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -97,7 +97,10 @@
 
 In 1938, hearings concerning charges of membership in the Communist political party against labor leader [[Harry Bridges]] were held on Angel Island before Dean James Landis of [[Harvard Law School]]. After eleven weeks …[line truncated]
 
-During World War II, the need for troops in the Pacific far exceeded prior needs. The facilities on Angel Island were expanded and further processing was done at Fort Mason in San Francisco. Prior to the war, the infras …[line truncated]
+During World War II, the need for troops in the Pacific far exceeded prior needs. The facilities on Angel Island were expanded and further processing was done at Fort Mason in San Francisco. Prior to the war, the infras …[line truncated]
+
+{{anchor|World War II prisoner-of-war camp}}
+Fort McDowell was used as a detention station for [[Internment of Japanese Americans|Japanese]], [[Internment of German Americans|German]] and [[Internment of Italian Americans|Italian]] immigrant residents of Hawaii ar …[line truncated]
 
 After World War II ended, the reorganization of the San Francisco Port of Embarkation did not include Fort McDowell, and the post was decommissioned on August 28, 1946.<ref>{{cite web |title=Fort McDowell (aka East Garr …[line truncated]
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …rted troops to and from Angel Island on a regular schedule. Fort McDowell was used as a detention station for [[Internment of Japanese Americans|Japanese]], [[Internment of German Americans|German]] and [[Internment of I …[window truncated]… partment of Justice|Department of Justice]] and Army camps. Japanese and German [[Prisoner of war|prisoners of war]] were also held on the island, supplanting immigration needs, which were curtailed during the war years.
  + …rted troops to and from Angel Island on a regular schedule. 
  pair 2:
  - 
  + 
  pair 3:
  - 
  + {{anchor|World War II prisoner-of-war camp}}
  pair 4:
  - 
  + Fort McDowell was used as a detention station for [[Internment of Japanese Americans|Japanese]], [[Internment of German Americans|German]] and [[Internment of Italian Americans|Italian]] immigrant residents of Hawaii arr …[window truncated]… partment of Justice|Department of Justice]] and Army camps. Japanese and German [[Prisoner of war|prisoners of war]] were also held on the island, supplanting immigration needs, which were curtailed during the war years.
```

**Diagnosis:** The World War II paragraph splits in two, with an invisible `{{anchor}}` inserted before the second half; the detention-station text moves verbatim. No rendered change.

#### sfba 1369348871 — Peter Thiel

label keys: Paragraph, Reference, Section, Sentence, Template, Wikilink, Word | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -256,11 +256,11 @@
 
 In May 2016, Thiel confirmed in an interview with ''[[The New York Times]]'' that he had paid $10 million in legal expenses to finance several lawsuits brought by others, including a lawsuit by Terry Bollea ([[Hulk Hoga …[line truncated]
 
-Thiel said he was motivated to sue Gawker after they published a 2007 article publicly [[outing]] him, headlined "Peter Thiel is totally gay, people."<ref>{{cite web |url=https://gawker.com/335894/peter-thiel-is-totally …[line truncated]
+Thiel said he was motivated to sue Gawker after they published a 2007 article publicly [[outing]] him, headlined "Peter Thiel is totally gay, people."<ref>{{cite web |url=https://gawker.com/335894/peter-thiel-is-totally …[line truncated]
 
 On 15 August 2016, Thiel published an opinion piece in ''The New York Times'' in which he argued that his defense of online privacy went beyond Gawker.<ref name="nytimesopedonlineprivacyaugust15">{{cite news|last1=Thiel …[line truncated]
 
-In an open letter to Thiel after losing the case, Gawker's [[Nick Denton]] accused Thiel of making them "stripped naked", together with the warning "in the next phase, you too will be subject to a dose of transparency.  …[line truncated]
+In an open letter to Thiel after losing the case, Gawker's [[Nick Denton]] accused Thiel of making them "stripped naked", together with the warning "in the next phase, you too will be subject to a dose of transparency.  …[line truncated]
 
 == Views and political activities ==
… (2 more lines in this hunk)

divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - … [[freedom of the press]], Thiel cited his donations to the {{not a typo|Committee}} to Protect Journalists and stated, "I refuse to believe that journalism means mass…
  + … [[freedom of the press]], Thiel cited his donations to the [[Committee to Protect Journalists]] and stated, "I refuse to believe that journalism means mass…
  pair 2:
  - …thiel-twisted-224622733.html |access-date=5 June 2025 |work=Yahoo News |date=26 May 2016 |language=en-SG}}</ref> Later though, in 2025, Denton said that Thiel was right and did him a favor in forcing the sale of Gawker M …[window truncated]… inst Elon Musk, Aligning With Peter Thiel, and Selling That SoHo Loft |url=https://www.vanityfair.com/news/story/nick-denton-interview-thiel-musk |access-date=5 June 2025 |magazine=Vanity Fair |date=24 March 2025}}</ref>
  + …thiel-twisted-224622733.html |access-date=5 June 2025 |work=[[Yahoo News]] |date=26 May 2016 |language=en-SG}}</ref> Later though, in 2025, Denton said that Thiel was right and did him a favor in forcing the sale of Gawk …[window truncated]… th Peter Thiel, and Selling That SoHo Loft |url=https://www.vanityfair.com/news/story/nick-denton-interview-thiel-musk |access-date=5 June 2025 |magazine=[[Vanity Fair (magazine)|Vanity Fair]] |date=24 March 2025}}</ref>
```

**Diagnosis:** Link markup only, display text identical: `{{not a typo|Committee}} to Protect Journalists` → `[[Committee to Protect Journalists]]`, and inside refs `work=Yahoo News` → `work=[[Yahoo News]]`, `magazine=Vanity Fair` → `[[Vanity Fair (magazine)|Vanity Fair]]`. Link changes are ignored by policy.

### SFBA carry-neither (1 entry)

#### sfba 1365231893 — Apple Inc.

label keys: Section | verdict: substantive=true reasons=[prose] ignored=[]

```diff
@@ -219,6 +219,8 @@
 
 In 2001, Apple made three announcements that would shape its future direction. On March 24, Apple released [[Mac OS X]], its next-generation operating system after years of failed attempts to modernize the classic Mac O …[line truncated]
 
+In 2002, Apple acquired [[Nothing Real]] for its digital [[compositing]] application [[Shake (software)|Shake]],<ref>Chaffin, Bryan: [http://www.macobserver.com/article/2002/02/07.6.shtml "Apple Shake: Apple Buys Nothin …[line truncated]
+
 [[File:ITunes Store Songs Sales.jpg|thumb|The iTunes Store was highly successful in shaping the legal [[music download]]ing industry; chart shows the number of songs sold from 2003 to 2010.]]
 
 In 2003, Apple launched the [[iTunes Store]], allowing customers to purchase and [[Music download|download music]] for 99¢ per song. The service quickly became the leading online music retailer, reaching more than 5 bil …[line truncated]
@@ -229,8 +231,6 @@
 |2={{#invoke:Cite|web |last=Arthur |first=Charles |date=April 28, 2013 |title=iTunes is 10 years old today. Was it the best idea Apple ever had? |url=https://www.theguardian.com/technology/2013/apr/28/itunes-10-years-ol …[line truncated]
 }}</ref> The iTunes Store helped transform the music industry by shifting consumers from unauthorized file-sharing services such as [[Napster]] toward paid digital distribution.
 
-In 2002, Apple acquired [[Nothing Real]] for its digital [[compositing]] application [[Shake (software)|Shake]],<ref>Chaffin, Bryan: [http://www.macobserver.com/article/2002/02/07.6.shtml "Apple Shake: Apple Buys Nothin …[line truncated]
-
 [[File:MacBook Pro.jpg|thumb|[[MacBook Pro]], Apple's first laptop with an [[Intel]] processor, introduced in 2006]]
 
 At the [[Worldwide Developers Conference]] on June 6, 2005, Jobs announced that Apple would [[Mac transition to Intel processors|transition the Mac from PowerPC to Intel processors]] beginning in 2006.<ref name="printel …[line truncated]


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …], Apple, January 7, 2002. Retrieved October 30, 2015.</ref>
  + …], Apple, January 7, 2002. Retrieved October 30, 2015.</ref>
  pair 2:
  - 
  +
```

**Diagnosis:** The "In 2002, Apple acquired Nothing Real…" paragraph moves from after the iTunes passage to before it. Wording identical; document order changed, and the order-sensitive prose channel fires. mwedittypes emitted only Section. A genuine catch of a reorder.

---

### Enwiki-random missed-prose (12 entries)

#### enwiki-random 1369305551 — Kowloon City District SA

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -60,7 +60,7 @@
 * '''Surface:''' Natural Grass
 * '''Opened:''' 1988
 
-Since 2026–27 season, the club returned to [[Kowloon City District]] as they relcocated to [[Kai Tak Sports Park|Kai Tak Youth Sports Ground]] .
+Since 2026–27 season, the club returned to [[Kowloon City District]] as they relcocated to [[Kai Tak Sports Park|Kai Tak Youth Sports Ground]].
 
 ==Name history==
 * 2002–2021: '''Kowloon City''' (九龍城)
```

**Diagnosis:** A space before the sentence-final period removed (`]] .` → `]].`). Whitespace only.

#### enwiki-random 1368653006 — List of Coronation Street characters introduced in 2026

label keys: Paragraph, Section, Sentence, Template, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -275,10 +275,9 @@
 {{clear}}
 
 ==Celeste==
-'''Celeste''', portrayed by [[Frances Barber]], is the estranged aunt of [[Bernie Winter|Bernie Winter-Alahan]] ([[Jane Hazlegrove]]).<ref name="Frances Barber">{{cite news|title=Coronation Street casts new character fo …[line truncated]
+'''Celeste''', portrayed by [[Frances Barber]], is the estranged aunt of [[Bernie Winter|Bernie Winter-Alahan]] ([[Jane Hazlegrove]]).<ref name="Frances Barber">{{cite news|title=Coronation Street casts new character fo …[line truncated]
 
-Speaking of her character, Barber said: "She reminds me completely of the women that I adored and grew up with, such as [[Elsie Tanner]] ([[Pat Phoenix]]). She's straightforward, witty and clever and says it as it is."< …[line truncated]
-{{clear}}
+Barber also spoke about her experiences and how they relate to her upcoming role: "The truth is that I've wanted to walk the cobbles for 40 years. It was on my bucket list. I'm a complete and utter fanatic. I grew up on …[line truncated]
 {{clear}}
 
 == Other characters ==
… (1 more lines in this hunk)

divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …ng out and she's not ready to forgive.<ref name="Celeste"/> 
  + …ng out and she's not ready to forgive.<ref name="Celeste"/> Speaking of her character, Barber said: "She reminds me completely of the women that I adored and grew up with, such as [[Elsie Tanner]] ([[Pat Phoenix]]). She' …[window truncated]… o she's dressed head to foot in cow print and cowboy outfits. She even sings a bit of Dolly Parton at one point. She's wonderful. It was the gift of a part for any actress my age and I relished it."<ref name="Celeste"/> 
  pair 2:
  - Speaking of her character, Barber said: "She reminds me completely of the women that I adored and grew up with, such as [[Elsie Tanner]] ([[Pat Phoenix]]). She's straightforward, witty and clever and says it as it is."<r …[window truncated]… . She even sings a bit of Dolly Parton at one point. She's wonderful. It was the gift of a part for any actress my age and I relished it."<ref name="Celeste"/> Barber also spoke about her experiences and how they relate …
  + Barber also spoke about her experiences and how they relate …
  pair 3:
  - {{clear}}
  +
```

**Diagnosis:** Paragraph merge: the two Barber quote sentences move verbatim from their own paragraph into the tail of the preceding paragraph, and a duplicate `{{clear}}` is dropped. The unified diff pairs the lines misleadingly; the quotes are unchanged.

#### enwiki-random 1368652976 — Glove

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -62,8 +62,8 @@
 * [[Chainmail]] gloves are used by butchers, woodcutters and police
 * [[Chainsaw safety clothing#Gloves|Chainsaw safety gloves]]
 * Chemical-resistant gloves
-*Cotton knitted gloves are used in automotive workshops, building maintenance, logistic material movement 
-*Temperature protective gloves
+* Cotton knitted gloves are used in automotive workshops, building maintenance, logistic material movement 
+* Temperature protective gloves
 * [[Cut-resistant gloves]]
 * Fireman's gauntlets
 * Food service gloves
@@ -124,7 +124,7 @@
 * [[Washing mitt]] or Washing glove: a tool for [[washing]] the body (one's own, or of a [[child]], a [[patient]], a lover).
 * Webbed gloves – a swim training device or swimming aid.
 * [[Olympic weightlifting|Weightlifting]] gloves
-*[[Wired glove]]
+* [[Wired glove]]
 ** [[Power Glove]] – an alternate controller for use with the [[Nintendo Entertainment System]]
 * Wheelchair gloves – for users of manual [[wheelchair]]s
 
@@ -239,7 +239,7 @@
 
 * [https://books.google.com/books?id=nikDAAAAMBAJ&pg=PA150 "Fitting The Glove To The Job", September 1949, ''Popular Science'']
 * [https://latvians.com/index.php?en/CFBH/Zimes/zimes-20-natomittens.ssi Gallery of Latvian souvenir mittens for 2006 NATO summit]
-*O’Reilly, Jonquil (13 November 2015): [https://www.sothebys.com/en/articles/gloves-useful-symbols "Gloves: Useful Symbols"], [[Sotheby's]] article.
+* O’Reilly, Jonquil (13 November 2015): [https://www.sothebys.com/en/articles/gloves-useful-symbols "Gloves: Useful Symbols"], [[Sotheby's]] article.
 
 {{EB1911 |wstitle=Glove |volume=12 |pages=135–137}}
 {{Clothing}}
```

**Diagnosis:** List-marker spacing normalized (`*Cotton` → `* Cotton`, three places). Whitespace only.

#### enwiki-random 1368652951 — Grantchester (TV series)

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -209,13 +209,9 @@
 
 On 28 July 2021, ITV announced that filming for the seventh series of ''Grantchester'' had begun, with the series due for release on 11 March 2022, with Brittney directing for the first time. On 19 August 2022, ITV anno …[line truncated]
 
-In 2023, ITV announced that Series 9 would be the last to star Tom Brittney, and that he would be replaced by former ''[[Hollyoaks]]'' actor [[Rishi Nair]] in the role of Alphy Kotteram.<ref name="pbs.org"/>
+In 2023, ITV announced that Series 9 would be the last to star Tom Brittney, and that he would be replaced by former ''[[Hollyoaks]]'' actor [[Rishi Nair]] in the role of Alphy Kotteram.<ref name="pbs.org"/> The ninth s …[line truncated]
 
-The ninth series was broadcast on ITV in January 2025.
-
-On 8 May 2024, ITV announced the series had been renewed for a 10th series, scheduled to air in January 2026.
-
-On 9 July 2025, ITV announced the series would end after its 11th series. It aired on PBS in mid-2026.<ref name=PBS11 />
+On 8 May 2024, ITV announced the series had been renewed for a 10th series, scheduled to air in January 2026. On 9 July 2025, ITV announced the series would end after its 11th series. It aired on PBS in mid-2026.<ref na …[line truncated]
… (4 more lines in this hunk)

divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …i Nair]] in the role of Alphy Kotteram.<ref name="pbs.org"/>
  + …i Nair]] in the role of Alphy Kotteram.<ref name="pbs.org"/> The ninth series was broadcast on ITV in January 2025.
  pair 2:
  - The ninth series was broadcast on ITV in January 2025.
  + On 8 May 2024, ITV announced the series had been renewed for a 10th series, scheduled to air in January 2026. On 9 July 2025, ITV announced the series would end after its 11th series. It aired on PBS in mid-2026.<ref name=PBS11 />
  pair 3:
  - 
  + 
  pair 4:
  - On 8 May 2024, ITV announced the series had been renewed for a 10th series, scheduled to air in January 2026.
  + 
  pair 5:
  - 
  + 
  pair 6:
  - On 9 July 2025, ITV announced the series would end after its 11th series. It aired on PBS in mid-2026.<ref name=PBS11 />
  +
```

**Diagnosis:** Paragraph merges: "The ninth series…" joins the preceding paragraph and two announcement paragraphs merge. Wording unchanged.

#### enwiki-random 1367680251 — 2026 Toronto International Film Festival

label keys: Paragraph, Section, Sentence, Table, Whitespace, Wikilink | verdict: substantive=false reasons=[] ignored=[links]

```diff
@@ -387,13 +387,11 @@
 |-
 |colspan=2| ''Viva Carmen'' || Sébastien Laudenbach || France
 |-
-| ''[[We Are All Strangers]]''
-|我们不是陌生人|| [[Anthony Chen]] || Singapore
+| ''[[We Are All Strangers]]'' || 我们不是陌生人 || [[Anthony Chen]] || Singapore
 |-
 |colspan=2| ''Where the River Begins'' || [[Juan Andrés Arango]] || Canada, Colombia, Norway
 |-
-| ''[[Woman Unknown (film)|Woman Unknown]]''
-|''Kvinde ukendt''|| May el-Toukhy || Denmark
+| ''[[Woman Unknown (film)|Woman Unknown]]'' || ''Kvinde ukendt'' || [[May el-Toukhy]] || Denmark
… (4 more lines in this hunk)
```

**Diagnosis:** Two table rows reflowed from two source lines to one using `||` separators, and May el-Toukhy gains a wikilink with identical display text (reported via ignored `links`). Rendered cell content unchanged.

#### enwiki-random 1367202511 — Quiznos

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -89,7 +89,7 @@
 
 On June 11, 2018, Quiznos announced that it had been acquired by [[California]]-based High Bluff Capital Partners. The chain did not move its headquarters.<ref name=":0">{{cite news|url=https://www.denverpost.com/2018/0 …[line truncated]
 
-As of December 6, 2023, 145 Quiznos restaurants remained in the United States, down from 176 in 2022.<ref>{{cite web |title=Number of Quiznos locations in the USA in 2023 |url=https://www.scrapehero.com/location-reports …[line truncated]
+As of December 6, 2023, 145 Quiznos restaurants remained in the United States, down from 176 in 2022.<ref>{{cite web |title=Number of Quiznos locations in the USA in 2023 |url=https://www.scrapehero.com/location-reports …[line truncated]
 
 ==Advertising==
 The company's first major advertising push was a successful [[advertising]] campaign during the [[Super Bowl XXXVI|2002 Super Bowl]]. Early TV spots advertised the innovation of toasting sandwiches, as compared to the i …[line truncated]


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …date=April 24, 2022 |website=ScrapeHero |language=en}}</ref>A partnership with Nebraska gas station chain Pump & Pantry in 2022 has resulted in four successful locations, and plans to open six more<ref>{{Cite web |last=Trivedi |first=Dhruv |date=2026-02-14 |title=The Once-Popular Sandwich Chain Pushing For A Comeback |url=https://www.mashed.com/2096536/quiznos-pushing-for-comeback/ |access-date=2026-03-29 |website=Mashed |language=en-US}}</ref>.
  + …date=April 24, 2022 |website=ScrapeHero |language=en}}</ref> A partnership with Nebraska gas station chain Pump & Pantry in 2022 has resulted in four successful locations, and plans to open six more.<ref>{{Cite web |last=Trivedi |first=Dhruv |date=2026-02-14 |title=The Once-Popular Sandwich Chain Pushing For A Comeback |url=https://www.mashed.com/2096536/quiznos-pushing-for-comeback/ |access-date=2026-03-29 |website=Mashed |language=en-US}}</ref>
```

**Diagnosis:** A space added after a ref and the sentence's period moved from after the ref marker to before it. Extracted text identical.

#### enwiki-random 1366232855 — Ukraine's 12th electoral district

label keys: Paragraph, Section, Sentence, Whitespace, Wikilink | verdict: substantive=false reasons=[] ignored=[links]

```diff
@@ -27,7 +27,7 @@
 
 In its current form, it comprises the eastern part of the city of [[Vinnytsia]] and the settlements located east of the city. Within Vinnytsia, the district boundary generally follows the [[Southern Bug]] River, althoug …[line truncated]
 
-The district is notable for having been represented by the former [[President of Ukraine]] [[Petro Poroshenko]], who served as its [[People's Deputy of Ukraine|People's Deputy]] for three convocations before [[2014 Ukra …[line truncated]
+The district is notable for having been represented by the former [[President of Ukraine]] [[Petro Poroshenko]], who served as its [[People's Deputy of Ukraine|People's Deputy]] for three convocations before [[2014 Ukra …[line truncated]
 
 ==Location==
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …t was represented by his son, [[Oleksii Poroshenko]]. Since 2019, it has been represented by [[Anatolii Drabovskyi]] of the …
  + …t was represented by his son, [[Oleksii Poroshenko]]. Since [[2019 Ukrainian parliamentary election|2019]] , it has been represented by [[Anatolii Drabovskyi]] of the …
```

**Diagnosis:** "2019" wikilinked to the election article with identical display text (reported via ignored `links`); the stray space introduced before the comma does not survive wtf's text extraction.

#### enwiki-random 1365555148 — Greater Kuala Lumpur

label keys: Paragraph, Punctuation, Section, Sentence, Template, Text Formatting, Whitespace, Wikilink, Word | verdict: substantive=false reasons=[] ignored=[template-bag]

```diff
@@ -43,13 +43,14 @@
 | motto                           = <!-- images and maps ----------->
 | image_map                      = {{maplink|frame=yes|plain=yes|frame-align=center|frame-width=290|frame-height=240|zoom=9|frame-coord={{coord|3.239240|101.585083}}
 | type1=shape|id1=Q1865|title1=Kuala Lumpur|stroke-color1=#FBBF00|stroke-width1=0.5|fill1=#FF0000|fill-opacity1=0.4
+| type2=shape|id2=Q2701266|title2=Petaling District|stroke-color2=#FBBF00|stroke-width2=0.5|fill2=#037D50|fill-opacity2=0.4
 }}
 | map_alt = Map of Greater Kuala Lumpur
 | map_caption = Interactive map of Greater Kuala Lumpur
 {{Col-begin}}
 {{Col-break}}
 {{leftlegend|#FF0000|[[Kuala Lumpur]] & [[Putrajaya]]}}
-{{leftlegend|#037D50|[[Petaling Jaya]]}}
+{{leftlegend|#037D50|[[Petaling District]] <small>(incl. [[Petaling Jaya|City of Petaling Jaya]] & [[Subang Jaya|City of Subang Jaya]]}}</small>
… (4 more lines in this hunk)
```

**Diagnosis:** READER-VISIBLE, template-rendered: a second map shape (Petaling District) is added to the `{{maplink}}` and the `{{leftlegend}}` label changes from "Petaling Jaya" to "Petaling District <small>(incl. City of Petaling Jaya & City of Subang Jaya" — the editor left the parenthesis unclosed in the wikitext. The change surfaces only in the ignored `template-bag` channel — a documented cost of the template policy, not an invisible miss.

#### enwiki-random 1365403502 — Maybach Music Group

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -49,7 +49,7 @@
 * [[G Shytt]]
 * [[Pretty Tony]]
 * [[BSIC]]
-* [[joseph]] [[kargbo]]
+*[[joseph]] [[kargbo]]
 
 ===Former===
 * [[Deuce Pounds]]
```

**Diagnosis:** List-marker spacing (`* [[joseph]]` → `*[[joseph]]`). Whitespace only.

#### enwiki-random 1365100424 — Kushta

label keys: Paragraph, Punctuation, Section, Sentence, Template, Whitespace | verdict: substantive=false reasons=[] ignored=[template-bag]

```diff
@@ -2,7 +2,7 @@
 {{For|the city|Istanbul}}
 [[File:Kushta asinkun.jpg|thumb|right|250px|A Mandaic sign that reads ''kušṭa asinkun'' ({{lang|myz|ࡊࡅࡔࡈࡀ ࡀࡎࡉࡍࡊࡅࡍ}}, "May truth strengthen/heal you") at [[Yahya Yuhana Mandi]]]]
 {{Mandaeism}}
-In [[Mandaeism]], '''kushta''' or '''kušṭa''' ({{langx|myz|ࡊࡅࡔࡈࡀ|lit=truth}}, {{IPA|mid|ˈkuʃtˤa}}) can have several meanings. Its original literal meaning is "[[truth]]" in the [[Mandaic language]], and is thus typicall …[line truncated]
+In [[Mandaeism]], '''kushta''' or '''kušṭa''' ({{langx|myz|ࡊࡅࡔࡈࡀ|lit=truth}}, {{IPA|mid|ˈkuʃtˤɑ}}) can have several meanings. Its original literal meaning is "[[truth]]" in the [[Mandaic language]], and is thus typicall …[line truncated]
 
 ==In the World of Light==
 [[Mandaeans]] believe that in the [[World of Light]], the '''[[Mšunia Kušṭa]]''', or the world of ideal counterparts, exists, where everything has a corresponding spiritual pair (''[[dmuta]]'').<ref name="Buckley 2002"/ …[line truncated]
@@ -16,7 +16,7 @@
 
 The ''kušṭa'' handclasp is exchanged dozens of times between the novice and initiator during [[Tarmida#Ordination|priest initiation ceremonies]]. It is also exchanged during rituals that need to be performed by priests, …[line truncated]
 
-A common formula used in at the beginnings of Mandaean prayers and during rituals is ''{{Transliteration|myz|kušṭa asinkun}}'' ({{langx|myz|ࡊࡅࡔࡈࡀ ࡀࡎࡉࡍࡊࡅࡍ|lit=May truth strengthen you (plural)}}, {{IPA|mid|ˈkuʃtˤa aˈsɪnə …[line truncated]
+A common formula used in at the beginnings of Mandaean prayers and during rituals is ''{{Transliteration|myz|kušṭa asinkun}}'' ({{langx|myz|ࡊࡅࡔࡈࡀ ࡀࡎࡉࡍࡊࡅࡍ|lit=May truth strengthen you (plural)}}, {{IPA|mid|ˈkuʃtˤɑ aˈsɪnə …[line truncated]
 
 {{clear all}}
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …'''kušṭa''' ({{langx|myz|ࡊࡅࡔࡈࡀ|lit=truth}}, {{IPA|mid|ˈkuʃtˤa}}) can have several meanings. Its original literal meaning …
  + …'''kušṭa''' ({{langx|myz|ࡊࡅࡔࡈࡀ|lit=truth}}, {{IPA|mid|ˈkuʃtˤɑ}}) can have several meanings. Its original literal meaning …
  pair 2:
  - …ࡅࡍ|lit=May truth strengthen you (plural)}}, {{IPA|mid|ˈkuʃtˤa aˈsɪnəχon}}),<ref name="Qulasta2025">{{cite book |last=Gelbert |first=Carlos |last2=Lofts |first2=Mark J. |date=2025  |title=The Qulasta |location=Edensor Par …[window truncated]… arendon Press.</ref> The singular form, also commonly used, is ''{{Transliteration|myz|kušṭa asiak}}'' ({{langx|myz|ࡊࡅࡔࡈࡀ ࡀࡎࡉࡀࡊ|lit=May truth heal you (singular}}). During rituals ([[masbuta]], etc.), priests also often …
  + …ࡅࡍ|lit=May truth strengthen you (plural)}}, {{IPA|mid|ˈkuʃtˤɑ aˈsɪnəχon}}),<ref name="Qulasta2025">{{cite book |last=Gelbert |first=Carlos |last2=Lofts |first2=Mark J. |date=2025  |title=The Qulasta |location=Edensor Par …[window truncated]… gular form, also commonly used, is ''{{Transliteration|myz|kušṭa asiak}}'' ({{langx|myz|ࡊࡅࡔࡈࡀ ࡀࡎࡉࡀࡊ|lit=May truth heal you (singular}}, {{IPA|mid|ˈkuʃtˤɑ ˈasiak}}). During rituals ([[masbuta]], etc.), priests also often …
```

**Diagnosis:** READER-VISIBLE, template-rendered: two IPA vowels are corrected (ˈkuʃtˤa → ˈkuʃtˤɑ) inside `{{IPA}}` templates, and a third transcription `{{IPA|mid|ˈkuʃtˤɑ ˈasiak}}` is added for the singular form (visible in the divergence window; the addition sits past the hunk truncation). All three surface only in ignored `template-bag` — a documented cost of the template policy.

#### enwiki-random 1365100376 — Hugo (name)

label keys: List, Paragraph, Section, Template, Whitespace | verdict: substantive=false reasons=[] ignored=[template-bag]

```diff
@@ -93,6 +93,7 @@
 * [[Hugo Dittberner]] (born 1944), German writer
 * [[Hugo Eckener]] (1868–1954), German airship commander
 * [[Hugo Ekitike]] (born 2002), French footballer
+* {{anbl|Hugo Ernst}}
 * [[Hugo Fernández Artucio]] (born c. 1910s), Uruguayan academic and activist
 * [[Hugo Fernández Faingold]] (fl. c. 2000), Uruguayan politician
 * [[Hugo Ferreira de Farias]] (born 1997), Brazilian footballer
```

**Diagnosis:** READER-VISIBLE, template-rendered: a new list entry `{{anbl|Hugo Ernst}}` adds a name to the list. Surfaces only in ignored `template-bag` — a documented cost of the template policy.

#### enwiki-random 1364750491 — 2026 FIA Formula 3 Championship

label keys: Paragraph, Section, Table, Template, Whitespace, Wikilink | verdict: substantive=false reasons=[] ignored=[template-bag]

```diff
@@ -322,9 +322,9 @@
 !SR
 | rowspan="2" |{{nowrap|{{flagicon|ESP}} [[Circuit de Barcelona-Catalunya]]}}
 |
-|nowrap |{{Flagicon|AUS}} [[James Wharton (racing driver)|James Wharton]]
-|nowrap |{{Flagicon|AUS}} [[James Wharton (racing driver)|James Wharton]]
-|{{Flagicon|ITA}} [[Prema Racing]]
+| {{Flagicon|AUS}} [[James Wharton (racing driver)|James Wharton]]
+| {{Flagicon|AUS}} [[James Wharton (racing driver)|James Wharton]]
+| {{Flagicon|ITA}} [[Prema Racing]]
 | rowspan="2" |[[2026 Barcelona Formula 3 round|Report]]
 |-
 !FR
@@ -345,8 +345,8 @@
 !FR
 | nowrap | {{Flagicon|JPN}} [[Hiyu Yamakoshi]]
  |{{Flagicon|FRA}} [[Théophile Naël]]{{efn|[[Théophile Naël]] set the fastest lap but did not finish in the top ten, so he was ineligible to score the point for it. [[Noah Strømsted]] scored the point for setting the fa …[line truncated]
-|nowrap | {{Flagicon|DNK}} [[Noah Strømsted]]
-|{{Flagicon|ITA}} [[Trident Motorsport|Trident]]
+| {{Flagicon|DNK}} [[Noah Strømsted]]
+| {{Flagicon|ITA}} [[Trident Motorsport|Trident]]
 |-
 ! rowspan="2" |5
 !SR
@@ -367,7 +367,7 @@
 !SR
 | rowspan="2" nowrap="" |{{flagicon|BEL}} [[Circuit de Spa-Francorchamps]]
 |
-|nowrap| {{Flagicon|USA}} [[Ugo Ugochukwu]]{{efn|[[Ugo Ugochukwu]] set the fastest lap but did not finish in the top ten, so he was ineligible to score the point for it. TBD scored the point for setting the fastest lap  …[line truncated]
+|nowrap| {{Flagicon|USA}} [[Ugo Ugochukwu]]{{efn|[[Ugo Ugochukwu]] set the fastest lap but did not finish in the top ten, so he was ineligible to score the point for it. [[Jin Nakamura]] scored the point for setting the …[line truncated]
 | {{Flagicon|JPN}} [[Jin Nakamura]]
 | {{Flagicon|GBR}} [[Hitech Grand Prix|Hitech]]
 | rowspan="2" |[[2026 Spa-Francorchamps Formula 3 round|Report]]


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - |nowrap |{{Flagicon|AUS}} [[James Wharton (racing driver)|James Whart…
  + | {{Flagicon|AUS}} [[James Wharton (racing driver)|James Whart…
  pair 2:
  - |nowrap |{{Flagicon|AUS}} [[James Wharton (racing driver)|James Whart…
  + | {{Flagicon|AUS}} [[James Wharton (racing driver)|James Whart…
  pair 3:
  - |{{Flagicon|ITA}} [[Prema Racing]]
  + | {{Flagicon|ITA}} [[Prema Racing]]
  pair 4:
  - |nowrap | {{Flagicon|DNK}} [[Noah Strømsted]]
  + | {{Flagicon|DNK}} [[Noah Strømsted]]
  pair 5:
  - |{{Flagicon|ITA}} [[Trident Motorsport|Trident]]
  + | {{Flagicon|ITA}} [[Trident Motorsport|Trident]]
  pair 6:
  - …he top ten, so he was ineligible to score the point for it. TBD scored the point for setting the fastest lap among those fi…
  + …he top ten, so he was ineligible to score the point for it. [[Jin Nakamura]] scored the point for setting the fastest lap among those fi…
```

**Diagnosis:** Table cell attribute cleanup (`|nowrap |` → `| `), canonicalized away by design, plus one READER-VISIBLE footnote change inside `{{efn}}` ("TBD scored the point" → "[[Jin Nakamura]] scored the point"). The footnote surfaces only in ignored `template-bag` — a documented cost of the template policy.

Enwiki-random has no carry-neither entries: all 291 we-say-substantive-only
verdicts carry a mapped (Reference/Media/Heading/Table) or Template
mwedittypes key.

---

### Eswiki-random missed-prose (7 entries)

#### eswiki-random 174800231 — Boris Lagutin

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -39,7 +39,7 @@
 Después de los Juegos Olímpicos, Boris Nikolaevich Lagutin terminó su carrera como atleta. Después de graduarse de la Facultad de Biología de la [[Universidad Estatal de Moscú]], no se dedicó a la ciencia. Trabajó en el …[line truncated]
 
 == Muerte ==
-Vivía en Moscú . Murió repentinamente el 4 de septiembre de 2022.
+Vivía en Moscú. Murió repentinamente el 4 de septiembre de 2022.
 
 == Premios ==
 *[[Orden al Mérito por la Patria]] - Tercera y Cuarta Clase


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - Vivía en Moscú . Murió repentinamente el 4 de septiembre de 2022.
  + Vivía en Moscú. Murió repentinamente el 4 de septiembre de 2022.
```

**Diagnosis:** A space before the period removed (`Moscú .` → `Moscú.`). Whitespace only.

#### eswiki-random 174770270 — World Trade Center (1973-2001)

label keys: Paragraph, Section, Sentence, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -47,7 +47,7 @@
 | alto_siguiente = [[Torre Willis]]
 }}
 
-El '''World Trade Center''' (en español, «Centro de Comercio Mundial») era un complejo de edificios en la ciudad de [[Nueva York]] ([[Estados Unidos]]), que incluía a las emblemáticas '''Torres Gemelas''', inauguradas e …[line truncated]
+El '''World Trade Center''' (en español, «Centro de Comercio Mundial») era un complejo de edificios en la ciudad de [[Nueva York]] ([[Estados Unidos]]), que incluía a las emblemáticas '''Torres Gemelas''', inauguradas e …[line truncated]
 
 Al momento de su finalización, el ''World Trade Center 1'' (la Torre Norte) y ''World Trade Center 2'' (la Torre Sur), conocidos en conjunto como las ''Torres Gemelas'', eran los edificios más altos del mundo. Los otros …[line truncated]
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …e World Trade Center|fechaacceso=23 de marzo de 2016}}</ref> es el edificio más alto del [[hemisferio occidental]].
  + …e World Trade Center|fechaacceso=23 de marzo de 2016}}</ref>es el edificio más alto del [[hemisferio occidental]].
```

**Diagnosis:** A space after a closing ref removed (`</ref> es` → `</ref>es`). Whitespace only.

#### eswiki-random 174692400 — Patricia Ariza

label keys: Paragraph, Reference, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -21,7 +21,9 @@
 | final = {{fecha|27|2|2023}}
 }}
 {{Wikipedia Grabada|Patricia Ariza.ogg|thumb|Patricia Ariza|fecha= 31 de enero de 2023}}
-'''Patricia Elia Ariza Flórez''' ([[Vélez (Santander)|Vélez]], 27 de enero de 1946) es una [[artista plástica]], [[poetisa]], [[dramaturga]], [[actriz]] y [[activista]] [[Colombia|colombiana]]. Se desempeñó como [[Minis …[line truncated]
+'''Patricia Elia Ariza Flórez''' ([[Vélez (Santander)|Vélez]], 27 de enero de 1946) es una [[artista plástica]], [[poetisa]], [[dramaturga]], [[actriz]] y [[activista]] [[Colombia|colombiana]].
+
+Se desempeñó como [[Ministerio de Cultura de Colombia|ministra de la Cultura]] en el gobierno de [[Gustavo Petro]].<ref name="INFOBPAS" />
 
 Sobrevivió al [[Anexo:Hechos de violencia contra la Unión Patriótica|genocidio de la Unión Patriótica]]. Es fundadora de la Casa de la Cultura, hoy [[Teatro La Candelaria]], junto a [[Santiago García Pinzón|Santiago Gar …[line truncated]
 


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …turga]], [[actriz]] y [[activista]] [[Colombia|colombiana]]. Se desempeñó como [[Ministerio de Cultura de Colombia|ministra de la Cultura]] en el gobierno de [[Gustavo Petro]].<ref name="INFOBPAS"/>
  + …turga]], [[actriz]] y [[activista]] [[Colombia|colombiana]].
  pair 2:
  - 
  + 
  pair 3:
  - 
  + Se desempeñó como [[Ministerio de Cultura de Colombia|ministra de la Cultura]] en el gobierno de [[Gustavo Petro]].<ref name="INFOBPAS" />
```

**Diagnosis:** Paragraph split: the "Se desempeñó como ministra…" sentence moves verbatim to its own paragraph (a ref also becomes self-closing with a space). No wording change.

#### eswiki-random 174576593 — Slavko Vinčić

label keys: Paragraph, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -29,7 +29,7 @@
 == Vida privada ==
 En 2020 Slavko Vinčić fue detenido por presuntos vínculos con una red de [[narcotráfico]], [[prostitución]] y [[tráfico de armas]]. La detención tuvo lugar el 29 de mayo de 2020, en plena pandemia, cuando todos los país …[line truncated]
 
-El árbitro fue liberado pocas horas después tras prestar declaración. Dijo que no sabía nada de las actividades ilegales que estaban llevando a cabo en el local y que sólo había aceptado una invitación a comer con socio …[line truncated]
+El árbitro fue liberado pocas horas después tras prestar declaración. Dijo que no sabía nada de las actividades ilegales que estaban llevando a cabo en el local y que sólo había aceptado una invitación a comer con socio …[line truncated]
 
 == Torneos de selecciones ==
 Ha arbitrado en los siguientes torneos de selecciones nacionales:


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - … permitieron seguir arbitrando. Fue internacional desde 2010 .<ref name="Delito"/>
  + … permitieron seguir arbitrando. Fue internacional desde 2010.<ref name="Delito"/>
```

**Diagnosis:** A space before the period removed (`2010 .` → `2010.`). Whitespace only.

#### eswiki-random 174546113 — Acanthurus leucosternon

label keys: Paragraph, Reference, Section, Whitespace | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -31,14 +31,14 @@
 Archivo:Acanthurus xanthopterus boca.jpg|Boca y dientes de ''Acanthurus xanthopterus''
 </gallery>
 
-Su coloración es azul cielo, con una mancha blanca en el pecho. Cabeza negra, con una amplia banda blanca desde la base de la aleta pectoral hasta la garganta. No tiene puntos distintivos ni banda blanca bajo los ojos.  …[line truncated]
+Su coloración es azul cielo, con una mancha blanca en el pecho. Cabeza negra, con una amplia banda blanca desde la base de la aleta pectoral hasta la garganta. No tiene puntos distintivos ni banda blanca bajo los ojos.  …[line truncated]
 
 Alcanza los 54&nbsp;cm de largo.<ref>Sommer, C., W. Schneider and J.-M. Poutiers, 1996. FAO species identification field guide for fishery purposes. The living marine resources of Somalia. FAO, Rome. 376 p.</ref>
 
 Existe una variedad híbrida no descrita como especie denominada pez cirujano de garganta azul (Acanthurus cf leucosternon). Muchos especialistas especulan de que se trata de un cruce de forma estable con el Acanthurus n …[line truncated]
 
 == Hábitat y distribución ==
-Es una especie bentopelágica. Suele verse en [[Arrecifes de coral|arrecifes]] coralinos soleados, de aguas claras e islas. Normalmente en arrecifes aplanados y a lo largo de laderas exteriores. Su rango de profundidad e …[line truncated]
… (4 more lines in this hunk)
@@ -46,7 +46,7 @@
 Se nutre principalmente de algas, tanto [[Béntico|bénticas]], como filamentosas creciendo en rocas y crestas de [[arrecife]]. También come [[fitoplancton]].<ref>http://www.fishbase.org/TrophicEco/FoodItemsList.php?vstoc …[line truncated]
 
 == Reproducción ==
-Son monógamos,<ref>Whiteman, E.A. and I.M. Côté, 2004. Monogamy in marine fishes. Biol. Rev. 79:351-375.</ref> ovíparos y de fertilización externa, desovando en parejas. No cuidan a sus crías.<ref>Breder, C.M. and D.E.  …[line truncated]
+Son monógamos,<ref>Whiteman, E.A. and I.M. Côté, 2004. Monogamy in marine fishes. Biol. Rev. 79:351-375.</ref> ovíparos y de fertilización externa, desovando en parejas. No cuidan a sus crías.<ref>Breder, C.M. and D.E.  …[line truncated]
 
 La especie pertenece al conjunto de ''[[Acanthurus achilles|A.&nbsp;achilles]]'', junto a ''[[Acanthurus japonicus|A.&nbsp;japonicus]]'' y ''[[Acanthurus nigricans|A.&nbsp;nigricans]]'', que tienen propensión a [[Híbrid …[line truncated]
 
@@ -68,7 +68,7 @@
 * Sprung, Julian y Delbeek, J.Charles. (1994) (en inglés) ''The Reef Aquarium.'' Ricordea Publishing. 
 * Debelius, Helmut y Baensch, Hans A. (1997) ''Atlas Marino''. Mergus. 
 * Michael, Scott W. (2005) (en inglés) ''Reef aquarium fishes''. Microcosm.T.F.H. 
-* Nilsen, A.J. y Fossa, S.A. (2002) (en inglés) Reef Secrets. TFH Publications .
+* Nilsen, A.J. y Fossa, S.A. (2002) (en inglés) Reef Secrets. TFH Publications.
 
 == Enlaces externos ==
 {{Commons}}
@@ -76,7 +76,6 @@
 * [http://eol.org/pages/206882/details Encyclopedia of Life: Ficha especie] (en inglés)
 * [https://www.fishbase.org/summary/1257 Fishbase: Ficha especie] (en inglés)
 
-
 {{Control de autoridades}}
 [[Categoría:Acanthurus|leucosternon]]
 [[Categoría:Peces del océano Pacífico]]


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - ….) Smiths' sea fishes. Springer-Verlag, Berlin. (Ref. 3145)   http://www.fishbase.org/references/FBRefSummary.php?id=3145&…
  + ….) Smiths' sea fishes. Springer-Verlag, Berlin. (Ref. 3145) http://www.fishbase.org/references/FBRefSummary.php?id=3145&…
  pair 2:
  - … the Red Sea. Harper Collins Publishers, 400 p. (Ref. 9710)   http://www.fishbase.org/references/FBRefSummary.php?id=9710&…
  + … the Red Sea. Harper Collins Publishers, 400 p. (Ref. 9710) http://www.fishbase.org/references/FBRefSummary.php?id=9710&…
  pair 3:
  - …. Publications, Neptune City, New Jersey. 941 p. (Ref. 205)   http://www.fishbase.org/references/FBRefSummary.php?id=205&speccode=1256 External link.</ref> Las larvas pelágicas, llamadas ''Acronurus'', evolucionan a juveniles cuando alcanzan aproximadamente los 6 cm. 
  + …. Publications, Neptune City, New Jersey. 941 p. (Ref. 205) http://www.fishbase.org/references/FBRefSummary.php?id=205&speccode=1256 External link.</ref> Las larvas pelágicas, llamadas ''Acronurus'', evolucionan a juveniles cuando alcanzan aproximadamente los 6 cm.
  pair 4:
  - …ossa, S.A. (2002) (en inglés) Reef Secrets. TFH Publications .
  + …ossa, S.A. (2002) (en inglés) Reef Secrets. TFH Publications.
  pair 5:
  - 
  +
```

**Diagnosis:** Whitespace cleanup throughout: double spaces before URLs inside refs collapsed (three places), `Publications .` → `Publications.`, a trailing space and one blank line removed.

#### eswiki-random 174532978 — Condado de la Quintería

label keys: Other Tag, Paragraph, Punctuation, Section, Sentence, Whitespace, Wikilink, Word | verdict: substantive=false reasons=[] ignored=[links]

```diff
@@ -19,7 +19,7 @@
 * Manuel de Cárdenas y Cárdenas, (Andújar, 10 de noviembre de 1764-1834), '''IV conde de la Quintería'''.<ref name="PRUEBAS2"/> 
 :: Casó con Margarita de Cuadros y Jimena (n. Baeza, 24 de septiembre de 1810), hija de Manuel María de Cuadros y de Antonia Jiménez, casados en Baeza el 13 de octubre de 1801.<ref name="PRUEBAS2"/> Le sucedió su hijo:
 
-* Manuel Cárdenas y Cuadros (Andújar, 6 de junio de 1834-1895), '''V conde de la Quintería''' y caballero de la [[Orden de Santiago]].<ref name="PRUEBAS2">{{Cita libro |apellidos={{v|Cadenas y Vicent}} |nombre= Vicente| …[line truncated]
+* Manuel Cárdenas y Cuadros (Andújar, 6 de junio de 1834-1895), '''V conde de la Quintería''' y caballero de la [[Orden de Santiago]].<ref name="PRUEBAS2">{{Cita libro |apellidos={{v|Cadenas y Vicent}} |nombre= Vicente| …[line truncated]
 :: Casó con Enriqueta Carrasco y Lázaro de Torrijos (Murcia, 1840-Madrid, 1907),<ref>[http://www.memoriademadrid.es/doc_anexos/Workflow/4/230301/hem_genteconocida_19010911.pdf Fotografía de ella]. [https://commons.wikim …[line truncated]
 
 * Rafael Pérez de Vargas y Quero (baut. 16 de noviembre de 1870-7 de febrero de 1953) '''VI conde de la Quintería'''{{Harvnp|Soler Salcedo|2020|p=331}}, caballero de la [[Orden de Alcántara]] en 1920<ref>{{Cita publicac …[line truncated]


divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …ípico y del deporte'', 1881, p. 152 y ss, fig. p. 732</ref> <bdi>Fue, durante un tiempo, director de la [[:en:Manila_Mint|Casa de la Moneda]] de [[Manila|Manila.]]</bdi>
  + …ípico y del deporte'', 1881, p. 152 y ss, fig. p. 732</ref> Fue, durante un tiempo, director de la Casa de la Moneda de [[Manila]].
```

**Diagnosis:** Markup cleanup with the rendered sentence unchanged: a `<bdi>` wrapper removed, the interwiki link to en:Manila Mint removed (its display text becomes plain text), and `[[Manila|Manila.]]` becomes `[[Manila]].`. Link changes are reported via ignored `links`; the reader loses one link, which the links policy treats as gnoming.

#### eswiki-random 174443268 — Carla Speed McNeil

label keys: Paragraph, Section, Sentence, Text Formatting, Whitespace, Wikilink | verdict: substantive=false reasons=[] ignored=[]

```diff
@@ -2,25 +2,25 @@
 |imagen = 10.10.10CarlaSpeedMcNeilByLuigiNovi1.jpg
 |pie de imagen = McNeil en la [[New York Comic Con]] en [[Manhattan]], el 10 de octubre de 2010
 }}
-'''Carla Speed McNeil''' ([[Hammond (Luisiana)|Hammond]], 21 de enero de 1969) es una escritora, dibujante e ilustradora de [[Historieta|cómics]] [[estadounidense]] [[Ciencia ficción|de ciencia ficción]], más conocida p …[line truncated]
+'''Carla Speed McNeil''' ([[Hammond (Luisiana)|Hammond]], 21 de enero de 1969) es una escritora, dibujante e ilustradora de [[Historieta|cómics]] [[estadounidense]] [[Ciencia ficción|de ciencia ficción]], más conocida p …[line truncated]
 
 == Carrera ==
-La obra principal de McNeil es la serie de cómics de [[ciencia ficción]] ''[[Finder (historieta)|Finder]]'', que comenzó a autopublicar en 1996. En 2005, empezó a publicar ''Finder'' como [[webcómic]]. El cómic se publi …[line truncated]
+La obra principal de McNeil es la serie de cómics de [[ciencia ficción]] ''[[Finder (historieta)|Finder]]'', que comenzó a autopublicar en 1996. En 2005, empezó a publicar ''Finder'' como [[webcómic]]. El cómic se publi …[line truncated]
 
-La mayor parte de la carrera de McNeil se centra en colaboraciones con otros dibujantes y guionistas de cómics. En 2001, McNeil colaboró como ilustradora invitada en dos páginas para ''[[Transmetropolitan]]: Filth of th …[line truncated]
+La mayor parte de la carrera de McNeil se centra en colaboraciones con otros dibujantes y guionistas de cómics. En 2001, McNeil colaboró como ilustradora invitada en dos páginas para ''[[Transmetropolitan]]: Filth of th …[line truncated]
… (23 more lines in this hunk)

divergence windows (full first-to-last difference per changed line pair):
  pair 1:
  - …ómics de ciencia ficción ''[[Finder (historieta)|Finder]]''. <ref>{{Cita web|url=http://secure.onipress.com/creator/carla…
  + …ómics de ciencia ficción ''[[Finder (historieta)|Finder]]''.<ref>{{Cita web|url=http://secure.onipress.com/creator/carla…
  pair 2:
  - …asta que [[Dark Horse Comics]] comenzó a publicarlo en 2011. <ref>{{Cita noticia|url=http://www.publishersweekly.com/pw/b…
  + …asta que [[Dark Horse Comics]] comenzó a publicarlo en 2011.<ref>{{Cita noticia|url=http://www.publishersweekly.com/pw/b…
  pair 3:
  - …ransmetropolitan]]: Filth of the City'' de [[Warren Ellis]]. <ref>{{Cita noticia|url=http://sequart.org/database/19935/transmetropolitan-filth-of-the-city/|título=Transmetropolitan: Filth of the City {{!}} Sequart Databa …[window truncated]… agecomics.com/comics/releases/no-mercy-vol.-3-tp|fechaarchivo=2017-03-12|urlmuerta=dead}}</ref> La serie es publicada por [[Image Comics]] y continúa en curso. <ref>{{Cita web|url=https://imagecomics.com/comics/releases/…
  + …ransmetropolitan]]: Filth of the City'' de [[Warren Ellis]].<ref>{{Cita noticia|url=http://sequart.org/database/19935/transmetropolitan-filth-of-the-city/|título=Transmetropolitan: Filth of the City {{!}} Sequart Databas …[window truncated]… magecomics.com/comics/releases/no-mercy-vol.-3-tp|fechaarchivo=2017-03-12|urlmuerta=dead}}</ref> La serie es publicada por [[Image Comics]] y continúa en curso.<ref>{{Cita web|url=https://imagecomics.com/comics/releases/…
  pair 4:
  - …Science]],'' que es una colección sobre mujeres científicas. <ref>{{Cita libro|url=https://www.comixology.com/Dignifying-Science-Stories-About-Women-Scientists/digital-comic/30385|fechaarchivo=https://web.archive.org/web …[window truncated]… cribió y dibujó la historia "Frog and Snake Never Play Together" para la popular antología ''Cautionary Fables and Fairy Tales Vol 2: Africa Edition'' en 2014. <ref>{{Cita libro|url=https://www.comixology.com/Cautionary-…
  + …Science]],'' que es una colección sobre mujeres científicas.<ref>{{Cita libro|url=https://www.comixology.com/Dignifying-Science-Stories-About-Women-Scientists/digital-comic/30385|fechaarchivo=https://web.archive.org/web/ …[window truncated]… scribió y dibujó la historia "Frog and Snake Never Play Together" para la popular antología ''Cautionary Fables and Fairy Tales Vol 2: Africa Edition'' en 2014.<ref>{{Cita libro|url=https://www.comixology.com/Cautionary-…
  pair 5:
  - …nsation Comics Featuring Wonder Woman'', para [[DC Comics]]. <ref>{{Cita noticia|url=http://www.dccomics.com/comics/sensa…
  + …nsation Comics Featuring Wonder Woman'', para [[DC Comics]].<ref>{{Cita noticia|url=http://www.dccomics.com/comics/sensa…
  pair 6:
  - …[[Finder (historieta)|Finder]]'' y ''[[Shanda the Panda]]''. <ref>{{Cita web|url=http://www.hahnlibrary.net/comics/awards/lulu98.php|título=Friends of Lulu 1998 Lulu Awards|fechaacceso=2017-03-11|sitioweb=www.hahnlibrary.net}}</ref> McNeil también ganó el premio Ignatz al Nuevo Talento Prometedor en 1998. <ref>{{Cita web|url=http://www.spxpo.com/1998-ignatz-award-r…
  + …[[Finder (historieta)|Finder]]'' y ''[[Shanda the Panda]]''.<ref>{{Cita web|url=http://www.hahnlibrary.net/comics/awards/lulu98.php|título=Friends of Lulu 1998 Lulu Awards|fechaacceso=2017-03-11|sitioweb=www.hahnlibrary.net}}</ref> McNeil también ganó el premio Ignatz al Nuevo Talento Prometedor en 1998.<ref>{{Cita web|url=http://www.spxpo.com/1998-ignatz-award-r…
  pair 7:
  - McNeil fue nominada al premio Lulu del año en 2001 <ref>{{Cita web|url=http://www.hahnlibrary.net/comics/awards/lulu01.php|título=Friends of Lulu 2001 Lulu Awards|fechaacceso=2017-03-11|sitioweb=www.hahnlibrary.net}}</re …[window truncated]… [ComicsAlliance]]|idioma=en-US}}</ref> ''Finder: Voice'' ganó el [[Los Angeles Times Book Prize|premio Los Angeles Times Book Prize]] de 2011 (novela gráfica). <ref>{{Cita web|url=http://events.latimes.com/bookprizes/pre…
  + McNeil fue nominada al premio Lulu del año en 2001<ref>{{Cita web|url=http://www.hahnlibrary.net/comics/awards/lulu01.php|título=Friends of Lulu 2001 Lulu Awards|fechaacceso=2017-03-11|sitioweb=www.hahnlibrary.net}}</ref …[window truncated]… [[ComicsAlliance]]|idioma=en-US}}</ref> ''Finder: Voice'' ganó el [[Los Angeles Times Book Prize|premio Los Angeles Times Book Prize]] de 2011 (novela gráfica).<ref>{{Cita web|url=http://events.latimes.com/bookprizes/pre…
  pair 8:
  - …s dibujantes que merecen un reconocimiento a su trayectoria. <ref>{{Cita web|url=http://comicsalliance.com/women-lifetime…
  + …s dibujantes que merecen un reconocimiento a su trayectoria.<ref>{{Cita web|url=http://comicsalliance.com/women-lifetime…
  pair 9:
  - …ra la lista por un panel de artistas de cómics galardonados. <ref>{{Cita noticia|url=https://www.npr.org/2017/07/12/53386…
  + …ra la lista por un panel de artistas de cómics galardonados.<ref>{{Cita noticia|url=https://www.npr.org/2017/07/12/53386…
```

**Diagnosis:** Spaces before ref tags removed throughout (`. <ref>` → `.<ref>`). Whitespace only.

### Eswiki-random carry-neither (2 entries)

#### eswiki-random 174708582 — Franco Domínguez Ávila

label keys: Punctuation, Section, Whitespace | verdict: substantive=true reasons=[prose] ignored=[]

```diff
@@ -115,8 +115,6 @@
 |[[Trofeo de Campeones de la Liga Profesional de Fútbol|Trofeo de Campeones]]
 |[[Trofeo de Campeones de la Liga Profesional 2025|2025]]
 |}
-|}
-
 
 == Referencias ==
 {{listaref}}
\ No newline at end of file
```

**Diagnosis:** A stray duplicate `|}` — which renders as literal text below the table — is removed, plus a blank line. The prose channel sees the rendered-text change. A genuine catch; mwedittypes emitted no prose key.

#### eswiki-random 174532937 — Tobarra

label keys: ExternalLink, Section, Whitespace | verdict: substantive=true reasons=[prose] ignored=[]

```diff
@@ -352,7 +352,6 @@
 
 == Personas notables ==
 {{AP|Categoría:Personas de Tobarra}}
-https://youtube.com/shorts/zEwY8h7E1Jg?is=W4dVuScMTajt8x0g
 
 == Referencias ==
 {{listaref|2}}
```

**Diagnosis:** A bare YouTube URL pasted under "Personas notables" is removed. Bare URLs render as visible links and appear in extracted text, so the prose channel fires. A genuine catch (likely vandalism cleanup); mwedittypes labeled it ExternalLink.

---

### Template-Only Sample (we-say-substantive, mwedittypes carry only Template keys)

The first 10 entries per cohort of the Template-only bucket (110/121/100 entries),
with each verdict's `reasons` taken directly from `verdicts.jsonl`. The reason
names which channel wtf_wikipedia rendered the template into — that is the
verdict's own explanation, and it is machine data, not reviewer judgment.

**SFBA sample (first 10 of 110):**
- revid 1365723608 (San Francisco): reasons=[infobox-values]
- revid 1366987536 (San Francisco Bay Area): reasons=[infobox-values]
- revid 1364920366 (Oakland, California): reasons=[prose]
- revid 1366052738 (San Jose, California): reasons=[infobox-values]
- revid 1365629089 (Stanford University): reasons=[infobox-values]
- revid 1367043159 (Santa Clara County, California): reasons=[infobox-values]
- revid 1366868796 (Santa Clara County, California): reasons=[infobox-values]
- revid 1366868495 (Santa Clara County, California): reasons=[infobox-values]
- revid 1366021341 (Silicon Valley): reasons=[references]
- revid 1367224581 (Google): reasons=[infobox-values]

**Enwiki-random sample (first 10 of 121):**
- revid 1369305544 (Shield of the Americas): reasons=[infobox-values]
- revid 1369305501 (Rosanna Pansino): reasons=[infobox-values]
- revid 1369305440 (Mike Lamond): reasons=[infobox-values]
- revid 1369305425 (Denise Fox): reasons=[infobox-values]
- revid 1369153156 (Ashe (singer)): reasons=[infobox-values]
- revid 1369153040 (Rublon): reasons=[infobox-values]
- revid 1368991401 (2025–26 Women's Futsal League Bangladesh): reasons=[infobox-values]
- revid 1368991346 (2025–26 Women's Futsal League Bangladesh): reasons=[infobox-values]
- revid 1368991338 (Spirotaenia): reasons=[infobox-values]
- revid 1368991294 (2026 FIFA Intercontinental Cup): reasons=[infobox-values]

**Eswiki-random sample (first 10 of 100):**
- revid 174855762 (Club Atlético Banfield): reasons=[infobox-values]
- revid 174841561 (El Haragán y Compañía): reasons=[infobox-values]
- revid 174841543 (Mayerlyn Cordero Díaz): reasons=[infobox-values]
- revid 174827809 (Miguel Bernal Montes): reasons=[infobox-values]
- revid 174827755 (Héctor Vera): reasons=[infobox-values]
- revid 174814522 (Región de Los Ríos): reasons=[infobox-values]
- revid 174814487 (Carretera Federal 70D): reasons=[headings]
- revid 174800202 (Martín Ignacio de Loyola): reasons=[infobox-values]
- revid 174800189 (Departamento de Transporte de Wyoming): reasons=[infobox-values, media]
- revid 174785533 (Línea 2 del Tren Eléctrico Urbano de Guadalajara): reasons=[infobox-values]

**Characterization:** 27 of the 30 sampled entries fired through infobox-values
(one of those also through media); the other three through prose, references,
or headings. These are the channels
templates render into, so the bucket behaves as the design expects. The sampled
diffs were not individually opened; the claim here is only what the reasons
column shows.

---

## Spanish-Language Findings (Eswiki)

Spanish Wikipedia prose-labeled share: 561 prose of 997 compared edits (56.3%). English Wikipedia (enwiki-random): 755 prose of 1495 compared edits (50.5%). SFBA (all SF-focused, en): 690 prose of 1219 compared edits (56.6%). Spanish editing patterns show prose-heavy concentration similar to SFBA (both ~56%), with both differing from the general English random sample (50.5%). This variation reflects different Wikipedia cohorts and editing practices, not language-specific parsing failures. wtf_wikipedia multilingual parsing (template aliases, section markers) handles Spanish correctly; no language-specific defect identified across validation cohorts.

---

## Measurement History

| Date | SFBA | Enwiki-random | Eswiki-random |
|------|------|---------------|---------------|
| 2026-08-14 | 682/690 (98.8%) | 743/755 (98.4%) | 554/561 (98.8%) |

Classifier changes of 2026-08-15 (input cap resized to 800KB from measured
article-size data; references channel compares canonicalized wikitext alongside
json): all three gates reproduce unchanged; reference recall rose to 92.8%
(SFBA) and 89.5% (enwiki); every number in this document reflects the
post-change classifier.

Live pipeline observation, 2026-08-14: a `node page-watch.js --noop --verbose`
run with a local log-only overlay produced a verdict through the full
page-watch wiring (metadata filter → significance stage → verdict log) on a
live edit: `substantive-verdict: San Jose International Airport
substantive=true reasons=[tables] ignored=[] tags=[mobile edit,mobile web
edit]`.

Measurements taken with classifier code from this branch, after canonicalization fixes (cell/header separator normalization, table attribute stripping correctness, whitespace/markup normalization in raw-wikitext comparison, parameter sorting). Verdicts generated at classifier commit (see Provenance section).

---

## Provenance

Verdicts, bucket counts, and reference-recall figures were generated with `lib/edit-significance.js` as committed alongside this revision of the document — the most recent commit touching that file at or before this document's latest revision. All three cohorts were validated with that classifier build on 2026-08-15.

---

## Conclusion

**All three cohorts PASS the directional gate.** SFBA 682/690 (98.8%), enwiki-random 743/755 (98.4%), and eswiki-random 554/561 (98.8%), each ≥ 95%, measured 2026-08-14.

The 27 missed-prose disagreements (8 SFBA + 12 enwiki + 7 eswiki), each reviewed against its diff hunk above, fall into three classes:

- **20 whitespace or paragraph-reflow edits** — spaces around refs and punctuation, list-marker spacing, paragraph splits and merges with wording unchanged. Not reader-visible; the verdicts are correct.
- **3 link-markup edits with identical display text** (Peter Thiel, Ukraine's 12th electoral district, Condado de la Quintería; the TIFF entry combines this with table reflow). The `links` channel reports each in `ignored`; the links policy treats them as gnoming. In the Condado entry the reader does lose one interwiki link — that loss is the accepted cost of the links policy.
- **4 reader-visible changes rendered through templates**, all enwiki (Greater Kuala Lumpur map legend, Kushta IPA transcription, Hugo (name) list entry via `{{anbl}}`, 2026 FIA F3 footnote via `{{efn}}`). Each surfaces in `ignored: [template-bag]` and is dropped by the template policy. This is the measured cost of that policy in these cohorts: 4 of 2,006 prose-labeled edits (0.2%). A consumer with `substantive_only` enforcing would not post these four edits.

Among the 30 reviewed disagreements, none shows a reader-visible change with both `reasons` and `ignored` empty. Across all 3,711 compared edits, 160 not-substantive verdicts carry nothing in either list (68 SFBA + 52 enwiki + 40 eswiki, measured 2026-08-15), and 46 of those bear a mapped mwedittypes key (Reference/Media/Heading/Table) without a prose key — a population the gated review does not cover. A 12-entry sample of that population (4 per cohort, reviewed against divergence windows, drawn before the reference-wikitext fix) found: 9 correct verdicts (changes inside HTML comments, ref `name=` attributes, image-size parameters, link markup with identical display text), and three narrow miss classes where a reader-visible change went entirely unreported. One is closed; **two remain**:

- **closed 2026-08-15**: free text inside a `<ref>` beside a citation template (SFBA 1366782965, Stanford: junk text removed from a rendered footnote). The references channel now compares canonicalized wikitext alongside the json, so this class flags through `references`; gates are unchanged and reference recall rose (SFBA 296→298, enwiki 280→282 of the same denominators);
- a heading **level** change (SFBA 1368532464, Google: `==` → `===`) — the headings channel compares titles, not depth;
- removal of a named-ref backref (eswiki 174841544: a `<ref name=":27" />` reuse deleted, so a footnote marker disappears from a sentence) — the references list dedupes by citation.

The rest of the population was not individually reviewed. The two open miss classes are false negatives (conservative direction for the gate, which they do not affect, but real skips if `substantive_only` enforces). They are recorded here as known limitations pending a decision on whether to close them before enforcement.

The three "carry neither" entries (1 SFBA, 2 eswiki) are genuine catches: a paragraph reorder, a stray rendered `|}` removed, and a bare-URL removal — each visible to readers, each labeled by mwedittypes without a prose key.

Template-only verdicts fire through the channels templates render into (27 of 30 sampled: infobox-values). Reference recall (85.2–92.8%) is the secondary, ungated metric; its gap from the prose gate is not yet diagnosed (see that section).

Spanish Wikipedia edits gate at the same level as the English cohorts (98.8% vs 98.4–98.8%), and prose-labeled shares are 56.3% (eswiki), 56.6% (SFBA), 50.5% (enwiki-random). No language-specific parsing defect appeared in the reviewed entries; Spanish citation templates are compared through the references channel's raw-content fallback.
