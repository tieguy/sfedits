# edit-significance validation tooling

Measures lib/edit-significance.js against mwedittypes labels.
Design: docs/design-plans/2026-08-14-substantive-edit-filter.md (Phase 2).

Cohort layout (all under data/edit-significance-validation/, gitignored):

    <cohort>/edits.json        [{title, revid, parentid, ts, user, tags, comment}]
    <cohort>/pairs-cache/      one <revid>.txt wikitext file per revision
    <cohort>/labels.jsonl      {"revid", "title", "types": {mwedittypes diff}} per line
    <cohort>/verdicts.jsonl    {"revid", "substantive", "reasons", "ignored",
                                "fallback"?, "error"?} per line

Cohorts: sfba (imported from the 2026-08-14 analysis run), enwiki-random,
eswiki-random. The "-random" cohorts are sliced samples across a ~29-day
recentchanges window, one slice per 23-hour step so time-of-day precesses
across the clock (not a single most-recent slice, and not uniform random —
say "recent-window sample" in writeups).

Pipeline per cohort (all run from the repo root):

    node scripts/analysis/edit-significance/harvest-recentchanges.js <host> <cohort> <count> [--days 30]   # skip for sfba
    node scripts/analysis/edit-significance/fetch-pairs.js <cohort> [--host <host>]
    ./data/edit-significance-validation/venv/bin/python scripts/analysis/edit-significance/label-mwedittypes.py <cohort> <lang>
    node scripts/analysis/edit-significance/validate.js <cohort> [lang]

Gate (design): directional — of edits mwedittypes labels prose-touching,
>=95% must classify substantive. The reverse bucket (we-say-substantive-only)
is expected: infobox/ref/media/heading changes live under non-prose
mwedittypes keys. It is characterized and hand-reviewed, never gated.

Python setup (mwparserfromhell needs Python.h for its C tokenizer; use the
pure-Python fallback):

    python3 -m venv data/edit-significance-validation/venv
    WITHOUT_EXTENSION=1 data/edit-significance-validation/venv/bin/pip install mwparserfromhell
    data/edit-significance-validation/venv/bin/pip install mwedittypes
