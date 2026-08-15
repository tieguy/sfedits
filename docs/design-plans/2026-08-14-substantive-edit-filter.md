# Substantive-Edit Filter Design

## Summary

This design adds a content-level filter to the bot's delivery pipeline so it can skip edits that don't change what a reader sees — template churn, category tweaks, wikilink reshuffling — before they reach Discord, Mastodon, or Bluesky. The core is a new, self-contained module (`lib/edit-significance.js`) that takes the wikitext of two revisions, extracts several independently-classified "channels" (prose, infobox values, references, media, and headings count as substantive by default; templates, links, categories, and external links are ignored by default), and compares each channel across revisions to produce a verdict: did anything substantive change? The module has no knowledge of the bot's network layer, config, or delivery accounts, so it can later be extracted into a standalone package without disturbing the rest of the codebase.

The rollout is staged rather than switched on directly. Before any pipeline wiring, the classifier's verdicts are checked offline against edits a third-party tool (mwedittypes) has already labeled, across three test sets spanning English and Spanish Wikipedia, requiring 95% agreement per set. Once validated, the classifier is wired into the bot's existing per-delivery content-filter stage behind a new opt-in flag (`substantive_only`), following the same pattern as the current `cosmetic_only` filter. It first runs in log-only mode — classifying and logging every candidate edit but dropping nothing — so real-world verdicts can be reviewed against the live stream before the filter is allowed to actually drop anything. Any fetch or parse failure defaults to letting the edit through (a "conservative pass" policy), so the filter can only ever remove noise, never silently swallow a real edit.

## Definition of Done

- A content-level edit classifier (`lib/edit-significance.js`) answers "did this edit change what a reader sees?" from the wikitext of two revisions, with per-channel policy and a `lang` option.
- The classifier is validated offline against three mwedittypes-labeled cohorts (SFBA top-500, random enwiki, random eswiki) at ≥95% agreement per cohort, with disagreements reviewed by hand and the results written up in a dated analysis doc.
- A new per-delivery `edit_filters` option (`substantive_only`) plumbs the verdict into the existing content-filter stage, opt-in and off by default, with a conservative-pass failure policy.
- The filter ships in log-only mode first (classify and log, drop nothing), then is enabled per delivery in `config.base.json` after live verdicts are reviewed. Both deploy steps require explicit go, since pushes to `fork/integration` deploy.
- Rate-targeted watchlist sizing and the eswiki feed (LUI-166) are explicitly out of scope; this build makes them possible, not real.

## Glossary

**Wikipedia / MediaWiki concepts**

- **Wikitext**: The plain-text markup Wikipedia articles are stored and edited in, before it's rendered to HTML — e.g. `[[link]]`, `{{template}}`, `== heading ==`.
- **Revision / revid**: A single saved version of a wiki page; `revid` is its unique numeric ID. An edit is the difference between an old revision and a new one.
- **Infobox**: The structured key/value summary box (e.g. population, birth date) that appears on many Wikipedia articles.
- **Template / transclusion**: Reusable wiki markup (`{{...}}`) embedded in a page. Some templates render as visible text (e.g. `{{convert}}`); others are invisible bookkeeping.
- **Wikignoming ("gnoming")**: Community term for small, uncontroversial cleanup edits — formatting, categorization, typo fixes — the class of edit this filter targets for removal.
- **Cosmetic edit**: Community-recognized term (WP:COSMETICBOT) for an edit that changes only formatting, whitespace, or ordering, not the rendered output.
- **Change tags**: Machine-readable labels MediaWiki attaches to an edit, e.g. `mw-undo`, `mw-rollback`, `mw-manual-revert` for different kinds of reverts. This design logs them but never uses them to decide a verdict.
- **Revdeleted**: A revision whose content has been hidden from public view by an administrator; the classifier has to handle not being able to fetch such content.
- **Action API**: MediaWiki's primary read/write HTTP API (distinct from the newer REST API); used here to fetch two revisions' wikitext and tags in one batched request.
- **`maxlag`**: An Action API parameter that asks the API to back off when Wikimedia's database replication is lagging, as a courtesy to the site.
- **`recentchanges`**: An Action API list of recent edits on a wiki; used here to sample random edits for the validation cohorts.
- **enwiki / eswiki**: Shorthand for English Wikipedia and Spanish Wikipedia, used throughout as cohort/language labels.
- **SFBA top-500**: The San Francisco Bay Area watchlist of ~500 articles the bot currently tracks; one of the three cohorts used to validate the classifier.

**This repo and third-party tools**

- **wtf_wikipedia**: A third-party JavaScript library that parses wikitext into a structured document (prose, infoboxes, references, categories, etc.) instead of treating it as raw text. Already a dependency of this repo.
- **mwedittypes**: An independently-maintained tool that classifies Wikipedia edits into types. This design uses its labels as ground truth to validate the new classifier against, rather than hand-building labeled data from scratch.
- **Channel** (as used in this design): One named slice of a wikitext parse — e.g. "prose" or "categories" — that the classifier extracts from both revisions and compares independently to decide whether that slice changed.
- **Verdict**: The classifier's output for one edit: whether it counts as substantive, and which channels drove that call.
- **`cosmetic_only`**: The existing (currently dormant in production) per-delivery filter that `substantive_only` is modeled on.
- **`edit_filters` / `substantive_only`**: The new per-delivery config option this design adds, following the same schema as `cosmetic_only`.
- **Content-filter stage**: The point in the bot's existing per-edit pipeline (`page-watch.js`) where per-delivery filtering rules apply, after metadata filtering.
- **`actionSession()` / `lib/mw-api.js`**: This repo's wrapper around Action API calls, centralizing the operator User-Agent, rate-limit handling, and timeouts — the only sanctioned route to a Wikimedia host from this codebase.
- **Collapser / collapse window**: The bot's existing behavior of merging a burst of consecutive edits by the same editor into one delivery, evaluated as a single net diff from the oldest to the newest revision in the burst.
- **Conservative pass**: The failure policy under which any classification failure (fetch error, parse exception, timeout, oversize input) lets the edit through rather than dropping it, since the filter's job is only to remove clear noise.
- **Log-only mode**: A deployment stage where the classifier runs and records verdicts for every edit but drops nothing, so real-world behavior can be checked before enforcement is turned on.
- **Topic subscription**: The place-bot platform's mechanism for third parties to subscribe to edits on a region or topic; it inherits this filter for free because it shares the same filter schema.
- **Confusion matrix**: A table showing counts of correct vs. incorrect classifier predictions broken out by category; used here to report agreement with mwedittypes labels per cohort.
- **`nock`**: A Node.js library used in this repo's tests to intercept and mock HTTP requests, so network-touching code can be tested without hitting real servers.

## Architecture

The bot currently forwards every non-bot, non-minor edit on a watchlist article. Measured over 30 days of the live top-500 watchlist (complete census, 2026-07-15 → 2026-08-14): 40.6 such edits/day survive the metadata filters, and 43% of them change no prose — mostly template churn (~28% of survivors), plus category/wikilink/formatting gnoming. This design adds a content-level filter that drops edits which don't change what a reader sees, cutting the feed to a projected ~26–28 edits/day of substantive changes.

**Classifier module — `lib/edit-significance.js`.** Self-contained: takes two wikitexts, returns a verdict. No knowledge of deliveries, accounts, config files, or the network. This boundary is deliberate so a later extraction to a standalone `wtf-plugin-diff` npm package is a file move (see Additional Considerations).

Contract:

```js
classifyEdit(prevWikitext, currWikitext, { channels, lang = 'en' })
// → {
//     substantive: boolean,
//     reasons:  ['prose', 'infobox-values', ...],  // substantive channels that changed
//     ignored:  ['template-bag', 'categories', ...] // changed channels that don't count
//   }
```

Each **channel** is a named extraction from the wtf_wikipedia parse of both revisions, compared for change:

| Channel | Extraction | Default policy |
|---|---|---|
| `prose` | normalized `doc.text()` | substantive |
| `infobox-values` | per-infobox key→value maps from `doc.infoboxes()` | substantive |
| `references` | `doc.references()` | substantive |
| `media` | `doc.images()` | substantive |
| `headings` | section titles | substantive |
| `template-bag` | unrendered template list from `doc.templates()` | ignored |
| `links` | internal wikilink targets | ignored |
| `categories` | `doc.categories()` | ignored |
| `external-links` | external link targets | ignored |

Whitespace/formatting/punctuation differences never count (full community consensus that these are cosmetic; see Existing Patterns). Templates that wtf renders into text (`{{convert}}` and similar) are caught by the `prose` channel automatically. Policy (which channels count) lives in config; mechanics live in the module.

**Fetch helper — beside the `page-watch.js` call site.** One batched Action API request per edit (`revids=old|new`, `rvprop=content|tags`) through `actionSession()` from `lib/mw-api.js`, using the revids that `parseDiffParams()` (`lib/compare-diff.js`) already extracts from the edit's diff URL, and the wiki host carried by the edit event. The same response delivers change tags, which the pipeline currently never sees; tags are logged as annotation only (no filtering decisions — see the revert note below).

**Pipeline hook — the existing content-filter stage in `page-watch.js`** (where `cosmetic_only` runs: after the collapser, after metadata filtering, once per edit, applied per-consumer). If any surviving consumer sets `substantive_only`, the pipeline fetches the two revisions, calls `classifyEdit()` once, and applies the single verdict to each opted-in consumer. Consumers without the flag are untouched.

**Config — a new `edit_filters` key following `cosmetic_only` exactly:** added to `DEFAULTS` and `normalizeEditFilters()` in `lib/edit-filters.js`, opt-in, off by default, with channel overrides available at the same level. Topic subscriptions inherit it for free because they share the filter schema.

**Failure policy — conservative pass.** Fetch failure, revdeleted/missing content, parse exception, oversize input (cap with pass-through), or classification exceeding a time budget ⇒ the edit posts, with a logged warning. The filter may only remove noise, never silently eat real edits. This matches the conservative-bias convention already documented in `lib/edit-filters.js`.

**Reverts get no special casing.** The channel test is symmetric: a revert of visible vandalism is itself a prose change and posts (closing the loop for readers who saw the vandalism); a revert of invisible gnoming is itself invisible and drops. Revert-family tags (`mw-undo`, `mw-rollback`, `mw-manual-revert`) are logged but never decide anything.

**Collapser semantics.** Filtering runs on the combined edit (existing behavior), whose diff URL spans oldest→newest. The classifier therefore evaluates the *net* change of a burst: five self-cancelling tweaks classify as no change. Vandal and reverter are different users, hence different collapse windows — both post.

## Existing Patterns

- **`cosmetic_only` (`lib/edit-filters.js`, stage 2 in `page-watch.js`)** is the direct template: opt-in per-delivery content filter, normalized on every evaluation, conservative bias on uncertainty. This design is that pattern with a real classifier behind it. The regex-based `isCosmeticOnly()` stays untouched (it is dormant in live config).
- **`lib/mw-api.js` is the only route to Wikimedia hosts** (operator User-Agent, 429/`Retry-After`, timeouts, maxlag). The fetch helper uses `actionSession()` with a named `component`; the classifier itself never touches the network.
- **wtf_wikipedia over regexes** is established repo doctrine (the "a wikilink is not a unit of significance" gotcha; prose-link parsing idioms in `scripts/reassess.js:169-181`). The classifier extends that doctrine to the runtime path. wtf_wikipedia is already a dependency on `integration`.
- **Fixture-based filter tests** (`test/edit-filters.test.js` + `test/fixtures/diff-html/`): unit tests use static fixtures, no network; nock only where a fetch path is under test.
- **Memory caution (LUI-120 OOM history):** rendering caps in `lib/compare-diff.js` are the precedent. The classifier parses the two texts sequentially, holds no parse cache, and caps input size.
- **Community definitions borrowed, not invented:** "substantive = changes the output HTML or readable text" (Wikipedia:Bots/Dictionary); pywikibot `cosmetic_changes` and WP:COSMETICBOT enumerate the consensus-invisible classes (whitespace, formatting, reordering, tracking-template churn). The default channel policy is deliberately stricter than "changes output HTML" for links/categories — the feed's test is "worth a reader's attention" — and that divergence is a documented policy choice, overridable per delivery.

## Implementation Phases

### Phase 1: Classifier module
**Goal:** `classifyEdit()` works, pure and offline.

**Components:**
- `lib/edit-significance.js` — channel extractors over wtf_wikipedia parses, comparison, verdict assembly, `lang` option, input-size cap
- Tests in `test/edit-significance.test.js` with wikitext-pair fixtures under `test/fixtures/wikitext-pairs/` (template-churn, infobox-value, prose, whitespace-only, revert-pair, es-language, empty/revdeleted)

**Dependencies:** none.

**Done when:** all fixture verdicts correct; suite green.

### Phase 2: Offline validation against labeled cohorts
**Goal:** measured agreement with mwedittypes before any pipeline wiring; the go/no-go gate for the design.

**Components:**
- Validation tooling checked into `scripts/analysis/edit-significance/` (promoted from the 2026-08-14 scratchpad scripts: harvest, pair-fetch, mwedittypes labeling, comparison) so the run is reproducible
- Cohort data (gitignored) under `data/edit-significance-validation/` — SFBA cohort of 1,219 labeled edits already present; add ~1,500 random enwiki mainspace edits and ~1,000 eswiki edits via `list=recentchanges`, labeled with mwedittypes (`lang='es'` for eswiki)
- Dated analysis doc `docs/2026-XX-XX-edit-significance-validation.md`: per-cohort confusion matrices and disagreement review

**Dependencies:** Phase 1.

**Done when:** ≥95% agreement per cohort with the prose⇒substantive direction; ~30 disagreements per cohort hand-reviewed as judgment differences, not parser bugs; analysis doc written. If a cohort fails the bar, the confusion cases feed back into Phase 1.

### Phase 3: Pipeline integration in log-only mode
**Goal:** the bot classifies every candidate edit and logs verdicts; nothing is dropped yet.

**Components:**
- `substantive_only` + channel overrides in `lib/edit-filters.js` (`DEFAULTS`, `normalizeEditFilters()`, a needs-revisions predicate)
- Revision fetch helper (batched `revids` + tags) beside the content stage in `page-watch.js`; verdict applied per-consumer; conservative-pass paths
- Log-only mode (config switch) that runs classification for opted-in consumers but never drops, logging verdict + reasons + tags per edit
- Tests: filter plumbing in `test/edit-filters.test.js` style; fetch helper with nock; conservative-pass paths (fetch failure, parse throw, oversize)

**Dependencies:** Phases 1–2.

**Done when:** full suite green; local `--noop` run against the live stream shows verdict logs.

### Phase 4: Live log-only deployment and measurement
**Goal:** real-stream verdicts observed before any edit is dropped. **Outward-facing: needs explicit go (push = deploy).**

**Components:**
- `config.base.json` with `substantive_only` in log-only mode; deploy via the normal autoupdate path
- Several days of log review: measured would-drop rate vs the ~35% prediction, spot-check of would-dropped edits

**Dependencies:** Phase 3.

**Done when:** measured drop rate and spot-check reviewed with no false drops of substantive edits; findings appended to the Phase 2 analysis doc.

### Phase 5: Enable and document
**Goal:** the filter is live; docs describe the new present. **Outward-facing: needs explicit go.**

**Components:**
- `config.base.json`: `substantive_only: true` on the desired deliveries (log-only switch removed); rollback is deleting the flag
- Doc updates: `docs/deploy-toolforge.md` (config reference), CLAUDE.md (filter exists, conservative-pass invariant, channel-policy pointer)

**Dependencies:** Phase 4.

**Done when:** live feed verified posting substantive edits only (compare a day of posts against the logged stream); docs updated.

## Additional Considerations

**Follow-ups deliberately out of scope, enabled by this build:**
- *Rate-targeted watchlist sizing* ("one substantive edit per hour" instead of "top 500") — its own design once the post-filter rate is measurable; sizing must be defined post-filter since this filter roughly halves the rate.
- *Standalone `wtf-plugin-diff` package* — extraction of `lib/edit-significance.js` once proven live. No JS equivalent of mwedittypes exists (verified 2026-08-14); wtf_wikipedia upstream (spencermountain, solo-maintained, episodic) is unlikely to take it in core, so standalone-then-offer is the path.
- *eswiki feed* — tracked as LUI-166. This build makes the classifier language-clean and es-validated; the feed (stream subscription, watchlist, account config) is separate.

**Known i18n degradation:** wtf_wikipedia parses Spanish natively (verified: `Ficha de *` infoboxes, `Categoría:`, `{{cita web}}` refs), but its known-template *rendering* is English-tuned, so a non-English template with reader-visible output may land in the ignored `template-bag`. The eswiki validation cohort quantifies this before it matters.

**Validation-data location:** labeled cohort and regeneration scripts live in `data/edit-significance-validation/` (gitignored, local). The 232MB wikitext pair cache is not preserved; regenerating it is ~10 minutes of batched API fetches via the checked-in scripts.

**Anonymous rate-limit budget:** each filtered edit adds one API request (~40/day at current volume) on top of the diff fetch — far inside the 200 req/min anonymous cap, and it rides `lib/mw-api.js`'s existing 429 handling.
