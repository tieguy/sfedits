# The substantive-edit filter

Answers one question per edit — *did this change what a reader sees?* — so a
delivery feed can drop gnoming (template churn, category tweaks, link
reshuffling) before posting. Design rationale and alternatives:
`docs/design-plans/2026-08-14-substantive-edit-filter.md`. Measured validation:
`docs/2026-08-14-edit-significance-validation.md`.

## Data flow

`page-watch.js` runs the significance stage **between the metadata and content
filters** (and before the `--noop` early return, so no-post runs still show
verdicts) → `lib/revision-pair.js` fetches both revisions' wikitext and the new
revision's change tags in one batched Action API call →
`lib/edit-significance.js` parses each side with `wtf_wikipedia` and diffs 11
named channels → each consumer's `substantive_only` setting decides whether the
verdict drops it. Classification runs once per edit regardless of consumer
count.

## Modules

| Module | Holds |
|---|---|
| `lib/edit-significance.js` | the classifier. Pure: two wikitexts in, verdict out — no network, no config, no delivery knowledge, so extracting it to a standalone package stays a file move. Exports `classifyEdit`, `extractChannels`, `DEFAULT_CHANNELS`, `MAX_INPUT_CHARS` |
| `lib/revision-pair.js` | `fetchRevisionPair(diffUrl)` → `{prev, curr, tags}` or null; one batched `revids=from|to` request through `lib/mw-api.js`, component `edit-significance` |
| `lib/significance-stage.js` | `filterBySignificance(edit, consumers, deps)` → the consumers to keep. Fetch/classify/log/label are injected so unit tests can force every failure path |
| `lib/edit-filters.js` | the `substantive_only` and `substantive_channels` options, plus `needsSignificanceCheck` and `significanceDropReason` |
| `scripts/analysis/edit-significance/` | offline validation harness (harvest → fetch pairs → mwedittypes labels → compare). Its README carries the pipeline commands and the Python venv setup |

## Configuration

- **`substantive_only` is three-state, not a boolean**: `false` (off, the
  default) | `'log'` (classify and log the verdict, never drop) | `true`
  (enforce). `needsSignificanceCheck` is true for both `'log'` and `true`;
  only `true` can reach a drop. Any other value normalizes to `false`.
- **`substantive_channels`** on a consumer merges per-channel policy overrides
  (`{channelName: 'substantive'|'ignored'}`) over the defaults. Entries whose
  value is anything else are dropped at normalization, and the classifier
  treats an unrecognized policy value as substantive — a misspelled override
  can only over-deliver, never silently drop edits.
- When several opted-in consumers carry genuinely differing channel policies
  (compared with key order normalized), the stage logs a
  `CHANNEL OVERRIDE CONFLICT` line and applies the first configured policy.
  Per-consumer classification is not implemented.

## Channels

`prose`, `infobox-values`, `references`, `media`, `tables`, `headings`, and
`redirect` are substantive; `template-bag`, `links`, `categories`, and
`external-links` are ignored (reported in the verdict, never deciding it). The
full extraction and order-handling table lives in the design doc and matches
`DEFAULT_CHANNELS` exactly.

**Verdict shape**: `{substantive, reasons[], ignored[], fallback?, error?}`.
`reasons` names the substantive channels that changed, `ignored` the ignored
ones. `fallback` marks a verdict that could not be computed (`missing-content`,
`input-too-large`, `parse-error`) and always comes with `substantive: true`.

## Invariants

- **Conservative pass: any failure keeps the edit.** A missing revision pair, a
  parse throw, an oversized input, a network error — each yields a pass, at
  every layer (`classifyEdit` returns a fallback verdict;
  `filterBySignificance` catches and treats the verdict as absent;
  `significanceDropReason` returns null for a null, fallback, or malformed
  verdict). The filter may only remove noise. The stage's dependency injection
  exists so unit tests prove this rather than assume it.
- **Whitespace never decides a verdict.** Prose is whitespace-normalized and
  every other channel compares parsed structures; the channels that fall back
  to raw wikitext (tables, references) canonicalize it first — cell/header
  separator layout, attributes, named-parameter order. A "fix" that compares
  raw wikitext directly reintroduces the whole false-positive class.
- **Channels that extract nested wikitext compare rendered text only.**
  Embedded link targets are stripped from table cells and infobox values,
  because a link retarget with unchanged display text belongs to the `links`
  policy.
- `MAX_INPUT_CHARS` (1.5MB) and the deliberately sequential parses are memory
  guards — two concurrent parses of pathological pages are an OOM risk on the
  deployed bot.

## Operational notes

- Cost on the wire: one batched Action API request per candidate edit that any
  consumer opted in for; zero requests when no consumer opts in (tested).
- `--noop` runs classify against live Wikipedia (one request per matching
  edit) — deliberate, so verdicts are observable without posting.
- The oversize check runs after the fetch, so an oversized page still costs
  its transfer before it conservative-passes.

## Known limitations

Recorded with evidence in `docs/2026-08-14-edit-significance-validation.md`:
three reader-visible change classes report in neither `reasons` nor `ignored`
(free text inside a `<ref>` beside a citation template; a heading *level*
change; a deleted named-ref reuse), and reader-visible changes rendered through
templates are dropped by the `template-bag` policy (measured at 4 of 2,006
prose-labeled edits across the validation cohorts). None affects the
validation gate; all become real skips only if `substantive_only` enforces.
