# Postmortem — Bay Area election data repair, July 2026

Errors made while piloting the CA-11 race, and the rules they produced. The
methodology (`design-plans/2026-07-31-election-data-repair-methodology.md`)
states those rules going forward; this document is why they exist. It is a
record, not a plan — nothing here needs doing.

Two of these reached live Wikidata. Both were caught by a human asking a
question that the automated checks were not shaped to ask.

## 1. A statement written to a disambiguation page

**What happened.** Connie Chan's candidacy (`P3602`) was written to
`Q110933376`. That item is a Wikimedia disambiguation page (`P31 = Q4167410`),
not a person. The correct item is `Q105663114` — Connie Chan, human, member of
the San Francisco Board of Supervisors since 2021-01-08, enwiki
`Connie Chan (politician)`.

**Root cause.** The QID was resolved by looking up the enwiki title "Connie
Chan", which is itself a disambiguation page, and taking its `wikibase_item`.

**Why the check missed it.** The verification pass compared *labels*. Both items
are labelled "Connie Chan", so the check passed. A check that cannot fail on the
inputs most likely to be wrong — disambiguation pages, namesakes — is not a
check.

**Detected by.** Louie asking whether every P/Q/S ID had actually been
validated. It had not; the QIDs had been label-checked and the property IDs were
from memory.

**Rules produced.** Hard `P31 = Q5` filter before any candidacy statement;
resolve QIDs with corroborating evidence rather than by article title; the
bot's watchlist query carries `?person wdt:P31 wd:Q5` permanently so a
disambiguation page cannot enter the watchlist even if one is mis-linked again.

## 2. A false positive that cleared the confidence threshold

**What happened.** In the reconciliation pass over tail districts, "John
McBride" — a CA-9 candidate — scored into the `confident` tier and resolved to
`Q6247404`, a 19th-century American labour union leader.

**Root cause.** Evidence scoring rewards signals that a long-dead labour leader
genuinely has: US citizenship, an occupation, held positions, an enwiki article.
Every signal fired correctly and the answer was still wrong.

**Why no threshold fixes it.** The score measures "is this a plausible American
public figure", not "is this the person who ran in this race in 2026". Raising
the threshold discards real matches without excluding this one.

**Detected by.** A human reading the confident list.

**Rules produced.** The confident tier is reviewed, not trusted. The reviewer
checklist requires the item's dates and description to be consistent with a 2026
candidate. `rival_items` is recorded so a reviewer can see what a match was
chosen over.

**Measured rates**, same 52 candidates: label matching produced at least 5 wrong
items of 30; evidence scoring produced 1 known wrong item of 32. An order of
magnitude better, and not zero.

## 3. A citation that did not discriminate

**What happened.** The first CA-11 batch cited the SoS *Certified List of
Candidates*. That document lists all eleven CA-11 primary candidates and does
not distinguish the two who advanced; it would have supported a candidacy
statement for any of them.

**Root cause.** The plan called for the primary *results*; no results file was
found on the obvious SoS page, and the candidate list was substituted without
the substitution being surfaced.

**Correct source.** The certified Statement of Vote
(`sov/2026-primary/sov/76-us-rep.pdf`, p. 79): Wiener 95,816 (40.7%), Chan
69,899 (29.7%). Under top-two this establishes advancement.

**Rules produced.** A reference must *discriminate* — establish who is on the
November ballot, not merely who filed. Stated as a principle rather than a list
of acceptable document types, because a later over-correction ("never cite a
filing list") would have made every no-primary race permanently unlinkable.

## 4. Wrong class QID, conclusion survived

**What happened.** `Q15283424` was used and annotated as "United States House of
Representatives election". It is *United Kingdom general election*. The query
built on it returned empty, and that empty result was read as evidence that no
per-district CA House election items exist.

**Why it mattered less than it should have.** Re-checking by exact label and by
enwiki confirmed the conclusion independently: no per-district items or articles
exist for regular CA House cycles in 2020, 2022 or 2024 — only for the two 2026
special elections. The modelling decision was right for a reason that had not
actually been established when it was made.

**Rule produced.** An empty result is not evidence until the query that produced
it has been shown to work on a positive control.

## 5. Two scoping rules that were wrong on the evidence

**A ≥50% Bay-Area vote-share threshold** for districts. The measured
distribution has no natural gap, and the excluded tail contained Robert Rivas
(Speaker of the California State Assembly, AD-29 at 18% Santa Clara) and Mike
McGuire (Senate president pro tem, CA-1 at 42%). Share of a district's
electorate is not a proxy for whether an office represents Bay Area
constituents. Replaced by: any district touching a Bay Area county, with the
derivable bar doing the filtering.

**"The district list is stable until the 2031 redistricting."** False when
written. California redrew congressional districts mid-decade under Proposition
50 (November 2025), effective for 2026–2030. A list built from 2024 boundaries
would have been wrong for this cycle and would have failed silently. Replaced
by: the list is generated from the current cycle's Statement of Vote, with a
diff check that turns silent staleness into a failing test.

## What generalises

Every one of these was caught by a human, and none by the tooling. The common
shape is a check aligned with the way the answer was produced rather than with
the way it could be wrong: comparing labels after resolving by label, scoring
plausibility after selecting on plausibility, reading an empty result from an
unvalidated query.

That is the argument for the review step being mandatory rather than advisory,
and for the reviewer checklist asking questions the generator did not ask.
