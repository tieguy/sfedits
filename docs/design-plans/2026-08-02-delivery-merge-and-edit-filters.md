# Delivery Merge, Config Split, and Per-Subscription Edit Filters Design

## Summary

This design collapses two currently-separate posting pipelines in the sfedits bot into one. Today, edits to the SF account's watchlist are inspected, screened for PII, and posted by bespoke per-platform code, while place-bot topic subscriptions run through a newer, database-backed delivery module that only knows how to post to Discord. This work extracts a single typed delivery layer (`lib/delivery.js`) that both paths post through, adds a shared "edit filters" concept (drop bot edits, minor edits, small edits, or cosmetic-only edits) so every consumer — SF's own feeds and every DB subscription — can independently tune its own noise level, and removes two things that no longer belong: the PII screening step (fully deleted, not just disabled) and the Puppeteer/Chromium rendering fallback (satori+resvg becomes the only renderer). Alongside this, config loading is restructured per LUI-108: non-secret settings move into a committed `config.base.json`, and the opaque `SFEDITS_CONFIG` blob is replaced by four individual secret environment variables, with no backward compatibility retained.

The approach is staged so each piece can be verified independently before they're wired together: PII removal and Puppeteer removal go first (independent cleanups), then the config split, then the standalone filter-predicate module, then the delivery-layer unification, and finally the wiring that lets individual DB subscriptions carry their own filters — followed by a docs/rollout phase. A deliberate architectural choice threads through all of this: edit filtering happens in two stages, a cheap metadata check (bot flag, minor flag, byte delta — available straight off the EventStreams event) that runs before any diff is fetched or rendered, and a content check (cosmetic-only classification) that reuses the diff HTML the pipeline already fetches for other reasons. If no consumer survives the metadata stage, the expensive fetch-and-render work is skipped entirely — that's the actual mechanism by which post volume drops, not just a filter bolted on after the fact.

## Definition of Done

- The SF bot posts through the same delivery layer as place-bot subscriptions: one set of typed delivery handlers (Discord webhook, Bluesky, Mastodon) serves both config-defined deliveries and DB subscriptions.
- Post volume is configurable per consumer: every delivery/subscription can drop bot edits, minor edits, edits under a byte-delta threshold, and cosmetic-only edits. The SF feeds drop bot and minor edits by default.
- PII screening is fully removed: no `screenForPII`, no `pii_blocking`/`pii_alerts` config, no PII tests.
- Puppeteer/Chromium is fully removed: satori+resvg is the only renderer; no fallback path, no `.npmrc` skip-download workaround, no Puppeteer dependency.
- LUI-108 is implemented with no back-compat: non-secret config lives in a committed `config.base.json`; the only secrets are four individual env vars; `SFEDITS_CONFIG` support is deleted.
- `npm test` is green with the test DB up and `SFEDITS_REQUIRE_DB=1`.
- Live verification: `node page-watch.js --noop --verbose` classifies real stream edits with filter decisions logged; after deploy, one real post per platform is observed and the watchlist-sync log line confirms a non-empty watchlist.

## Glossary

- **EventStreams**: Wikimedia's real-time feed of edits across all wikis; the bot subscribes to it rather than polling, and it's the single source of "an edit happened."
- **satori + resvg**: The rendering pipeline that turns a diff into a PNG image (satori lays out styled text as SVG, resvg rasterizes it). This design makes it the *only* renderer, removing a Puppeteer/Chromium-based fallback.
- **Puppeteer**: A headless-Chrome browser automation library, previously kept as a fallback renderer. Being removed entirely, along with its Chromium download and the `.npmrc` workaround that suppressed that download during Toolforge builds.
- **PII screening**: A step (`screenForPII`) that inspected diffs before posting to avoid publishing personally identifiable information. Being deleted outright, including its config stanzas and tests — not merely disabled.
- **Delivery / delivery handler**: A typed poster for one platform (Discord webhook, Bluesky, Mastodon). "Delivery" here means the act/target of posting, as distinct from a DB "subscription" (a place-bot topic's registered Discord destination) or a config-defined "delivery" (an account-level posting target defined in `config.base.json`).
- **Subscription**: A place-bot platform concept — a consumer registered against a topic (region + filters) in the database, as opposed to config-defined deliveries which are declared in committed config for the SF account.
- **Edit filters (metadata-stage / content-stage)**: A per-consumer filter shape (`bots`, `minor`, `min_delta`, `cosmetic_only`) evaluated in two passes. The metadata stage checks fields already present on the EventStreams event (cheap, runs first); the content stage checks the fetched diff HTML (only runs if at least one consumer survives the metadata stage).
- **Cosmetic-only classification**: A conservative content-stage filter that identifies edits touching only templates, categories, refs, file/infobox parameters, or whitespace — i.e., no visible prose change. Deliberately biased toward false negatives (posting when unsure) because missing a real edit is worse than one extra noisy post.
- **Collapse / collapser**: The existing step that merges multiple rapid-fire edits to the same page into a single logical update before any filtering or posting happens, so it stays upstream of and shared across all consumers.
- **Watchlist-sync vs topic rebuild**: The two separate mechanisms that decide *which articles* a consumer cares about — a static/refreshed watchlist for the SF account, and a nightly set-diff rebuild for place-bot topics (region + filter criteria). This design intentionally does not merge these two.
- **`filters_hash` / `normalizeFilters`**: The existing mechanism (`lib/topic-store.js`) that hashes a topic's normalized filter settings to deduplicate identical topic subscriptions. Edit filters are deliberately kept *outside* this hash so two subscribers to the same topic can choose different noise levels without splitting the topic into two.
- **`RateCap` / `SubscriptionLimiter`**: Existing rate-limiting primitives (`lib/delivery-limits.js`) that cap how often a given consumer can be posted to; edit filters are additive to these, not a replacement.
- **Quarantine**: An existing mechanism that suspends a DB subscription's deliveries after repeated permanent (4xx, non-429) failures. This design keeps quarantine DB-subscription-only; config-defined deliveries instead fail loudly, since the bot operator owns those credentials directly.
- **`credential_ref`**: A named pointer in a config-defined delivery entry that resolves to the actual secret (e.g., a Bluesky password) inside the composed config at runtime, so neither the committed config file nor the database ever stores the secret itself.
- **SSRF guard / allowlist**: The existing restriction that Discord webhook delivery targets must be https and match a fixed set of allowed hosts, preventing the bot from being tricked into making requests to arbitrary internal/external URLs. This design explicitly leaves it unchanged and notes Bluesky/Mastodon (credential-based, not URL-based) don't need it.
- **Revdel sweeper**: The existing process (`lib/revdel-check.js`) that, when a Wikipedia revision is subsequently hidden ("revision-deleted"), deletes the bot's corresponding posts. This design extends it to sweep posts across all delivery types, not just the account's own historical posts.
- **Posted log**: The bot's append-only record of what it has posted where, used by the revdel sweeper to find posts to delete; this design adds `{delivery_type, post_id}` to each entry.
- **`config.base.json` / config overlay**: The new committed, non-secret config file, layered under a gitignored local `config.json` override and then four secret env vars — replacing the single opaque `SFEDITS_CONFIG` env var.
- **ToolsDB**: Wikimedia Toolforge's shared MySQL/MariaDB hosting service; the production database backing DB subscriptions.
- **`autoupdate`**: The bot's own 15-minute deploy poller on Toolforge — it rebuilds, migrates, and restarts processes automatically whenever `fork/integration` moves, which is why a push there counts as a live deploy.
- **LUI-108 / LUI-84 / LUI-109**: Linear issue IDs referenced as the tracking tickets for, respectively, the config-split work this design implements, the broader bot/platform unification this is one step toward, and a known watchlist-sync restart-order gotcha this design says it doesn't change.

## Architecture

Today `page-watch.js` runs two parallel pipelines: the account path (watchlist →
`inspect()` → collapse → PII screen → bespoke Bluesky/Mastodon/Discord posting) and
the platform path (topic-index → `lib/subscription-delivery.js` → Discord webhooks).
This design unifies them at the **delivery layer** while deliberately leaving the
two article-set mechanisms (watchlist-sync and topic rebuild) separate.

Target data flow:

```
EventStreams → edit-stream → match (watchlist ∪ topic-index) → collapse
  → metadata-stage filters (per consumer: bots / minor / min_delta)
  → [any consumer left?] fetch diff HTML once, verify page
  → content-stage filter (cosmetic_only, per consumer)
  → render diff image once (satori+resvg)
  → fan out to delivery handlers (discord | bluesky | mastodon)
  → posted-log records {delivery_type, post_id} per delivery
```

Key components:

- **`lib/delivery.js`** (grown from `lib/subscription-delivery.js`): typed delivery
  handlers. One payload shape in (page, diff image, alt text, rendered text, edit
  metadata), one post record out. The Discord webhook URL allowlist stays exactly
  as-is — it is an SSRF guard; Bluesky/Mastodon handlers take credentials, not URLs,
  so they do not touch the allowlist.
- **Config-defined deliveries**: the SF bot becomes watchlist-sync (unchanged) plus a
  `deliveries` list in committed config. Each entry:
  `{ type, credential_ref, template?, edit_filters? }`. `credential_ref` resolves
  against the composed config, so neither git nor ToolsDB ever holds a secret.
- **`lib/edit-filters.js`**: normalized filter shape and predicates, shared verbatim
  by config deliveries and DB subscriptions:

  ```json
  {
    "bots": false,
    "minor": false,
    "min_delta": 0,
    "cosmetic_only": false
  }
  ```

  `bots: false` means "drop edits flagged bot"; `minor: false` drops minor edits;
  `min_delta: N` drops edits with |length.new − length.old| < N; `cosmetic_only:
  false` (when enabled) drops edits whose diff only touches templates, categories,
  refs, file/infobox parameters, or whitespace. Null/absent filters mean no
  filtering. Two evaluation stages: metadata (free fields on every EventStreams
  event, evaluated before any fetch/render) and content (needs the diff HTML the
  pipeline already fetches for page verification). If no consumer survives the
  metadata stage, the diff fetch and render are skipped entirely — that is where
  API traffic and volume actually drop.
- **Config loader** (`lib/config.js`): composes `config.base.json` (committed,
  non-secret) → local `config.json` overlay (gitignored, dev convenience) → four
  secret env vars (`SFEDITS_BLUESKY_PASSWORD`, `SFEDITS_MASTODON_ACCESS_TOKEN`,
  `SFEDITS_DISCORD_WEBHOOK_URL`, `SFEDITS_INVITE_CODES`). Each layer overrides only
  what it sets. `SFEDITS_CONFIG` support is removed outright (single-deployer
  decision, 2026-08-02).
- **Posted log**: entries record `{delivery_type, post_id}` per delivery so the
  revdel sweeper can delete a swept revision's posts on every platform, including
  DB-subscribed Discord (today it only knows the account's own posts).

What each consumer keeps: per-delivery rate caps (existing `RateCap` /
`SubscriptionLimiter`); quarantine stays DB-subscription-only — config deliveries
fail loudly instead, since the operator owns those credentials. The edit collapser
stays upstream of delivery: collapse happens once per edit stream, not per
subscriber.

Cosmetic-only classification bias is conservative: when parsing is uncertain, post.
False negatives are noise; false positives are missed real edits, which is worse
for a feed people trust. Classification stays deliberately narrow (whole-line
changes clearly inside template/category/ref markup) — no clever nested-markup
heuristics, per the known regex-on-wikitext trap.

## Existing Patterns

Investigation (2026-08-02) found:

- **Per-account config stanzas** (`collapse`, `watchlist_source`) are the precedent
  for `deliveries` and `edit_filters` in config; ad-hoc reads, no schema. The design
  follows this.
- **`lib/delivery-limits.js` (`RateCap`, `SubscriptionLimiter`)** already provides
  per-consumer rate capping; filters slot in beside it rather than duplicating it.
- **Topic filter normalization** (`lib/topic-store.js` `normalizeFilters`/
  `filtersHash`) hashes topic-level filters for dedup. Edit filters deliberately do
  NOT join `filters_hash`: they attach per-subscription so two subscribers to one
  topic can pick different noise levels without splitting the topic. This is a
  considered divergence, not an oversight.
- **Schema changes are migration files** run by `lib/db.js`'s runner and recorded in
  `schema_migrations`; `autoupdate` applies them on deploy. Followed here.
- **Diff HTML is already fetched before posting** (`page-watch.js` `sendStatus()`,
  for page verification and — until now — PII screening). The content-stage filter
  reuses that fetch; no new Wikimedia API traffic.
- **Wikimedia API rules**: all requests via `lib/user-agent.js`, serial only. No new
  request types are introduced by this design.

## Implementation Phases

### Phase 1: Remove PII screening
**Goal:** Delete the PII path entirely.

**Components:**
- `page-watch.js` — remove `screenForPII()` (~lines 264–330) and its call in
  `sendStatus()`; diff HTML fetch and `verifyDiffPage` remain
- `lib/config.js` consumers — drop `pii_blocking` / `pii_alerts` handling
- Tests covering PII screening removed; `config.json.template` references removed

**Dependencies:** None.

**Done when:** No `pii` reference remains in `lib/`, `page-watch.js`, or tests
(grep-clean); full suite passes.

### Phase 2: Remove Puppeteer/Chromium
**Goal:** satori+resvg is the only renderer.

**Components:**
- `lib/diff-image.js` — remove the Puppeteer fallback path
- `package.json` — drop the Puppeteer dependency; `.npmrc` — remove
  `puppeteer_skip_download`
- Tests for the fallback path removed

**Dependencies:** None (parallel to Phase 1).

**Done when:** No Puppeteer reference in code or lockfile; manual pipeline check
(`captureDiffImage` against a real diff URL) produces a correct PNG; suite passes.

### Phase 3: Config split (LUI-108, no back-compat)
**Goal:** Committed non-secret config; four secret env vars; `SFEDITS_CONFIG` deleted.

**Components:**
- `config.base.json` (new, committed) — full non-secret config, replacing
  `config.json.template`
- `lib/config.js` — overlay loader: `config.base.json` → local `config.json` →
  `SFEDITS_BLUESKY_PASSWORD` / `SFEDITS_MASTODON_ACCESS_TOKEN` /
  `SFEDITS_DISCORD_WEBHOOK_URL` / `SFEDITS_INVITE_CODES`; `SFEDITS_CONFIG` and
  `config.json.template` support removed
- `test/config.test.js` — rewritten for layer precedence and per-secret overlay

**Dependencies:** Phase 1 (PII stanzas gone shrinks the committed base).

**Done when:** Loader tests prove each layer and precedence; secrets never appear in
any committed file; suite passes.

### Phase 4: Edit filter module
**Goal:** Shared filter shape and predicates.

**Components:**
- `lib/edit-filters.js` — `normalizeEditFilters(filters)`,
  `passesMetadata(edit, filters)`, `isCosmeticOnly(diffHtml)`,
  `passesContent(diffHtml, filters)`
- `test/edit-filters.test.js` — metadata predicates against synthetic edits;
  cosmetic classification against real diff HTML fixtures (template-only,
  category-only, ref-only, mixed, prose)

**Dependencies:** None (parallel to Phases 1–3).

**Done when:** Unit tests pass, including the conservative-bias cases (uncertain
parse → not cosmetic).

### Phase 5: Delivery unification
**Goal:** One delivery layer for accounts and subscriptions.

**Components:**
- `lib/delivery.js` — typed handlers `discord` (existing webhook path moved),
  `bluesky`, `mastodon` (posting code moved out of the account path);
  `credential_ref` resolution against composed config
- `page-watch.js` — account path posts through `lib/delivery.js`; `deliveries`
  config list replaces the per-platform account stanzas
- Posted log — entries carry `{delivery_type, post_id}`; `lib/revdel-check.js`
  sweeps across all delivery types
- Tests: handler behavior via nock per platform; revdel sweep across mixed
  delivery types; allowlist unchanged for webhook types

**Dependencies:** Phases 3 (credential refs need the composed config) and 4 (payload
shape carries filter metadata).

**Done when:** All three platforms post through the unified layer in tests; revdel
sweep deletes across platforms in tests; suite passes.

### Phase 6: Per-subscription filters wired in
**Goal:** The volume knob, live end to end.

**Components:**
- `db/migrations/` — new migration: `ALTER TABLE subscriptions ADD COLUMN
  edit_filters JSON NULL` (null = no filtering)
- `lib/topic-store.js` — read/write `edit_filters` on subscriptions
- `page-watch.js` — metadata-stage evaluation per consumer before fetch/render;
  skip fetch+render when no consumer survives; content stage after diff fetch;
  filtered edits logged with reason
- `config.base.json` — SF deliveries default to `{"bots": false, "minor": false}`
- Tests: fan-out with mixed per-consumer filters; skip-render-when-all-filtered;
  migration applies cleanly on the test DB

**Dependencies:** Phases 4 and 5.

**Done when:** DB-backed tests prove per-subscription filtering; `--noop --verbose`
against the live stream logs filter decisions on real edits.

### Phase 7: Docs and rollout
**Goal:** Documentation matches reality; deploy executed safely.

**Components:**
- `docs/deploy-toolforge.md` §3, `docs/config-topic-store.md`, repo CLAUDE.md —
  updated together for the new config shape, removed PII/Chromium, delivery layer
- Rollout runbook (in `deploy-toolforge.md`): create the four env vars **before**
  pushing (autoupdate deploys within 15 minutes and the new code cannot read
  `SFEDITS_CONFIG`) → push on explicit go → verify `/changelog`, the
  `✓ Watchlist sync: N articles` line, one real post per platform → delete
  `SFEDITS_CONFIG`

**Dependencies:** Phases 1–6.

**Done when:** Docs updated in the same change; deploy verified live per the
runbook; `SFEDITS_CONFIG` deleted from Toolforge.

## Additional Considerations

**Deploy coupling:** pushing to `fork/integration` is a deploy. All phases land as
local commits; the push happens once, after explicit go, with the env vars staged
first. The web-before-bot restart-order gotcha (LUI-109) applies unchanged.

**Filter observability:** every dropped edit logs consumer + reason. This is the
mechanism for tuning `min_delta`/`cosmetic_only` before trusting them — watch what a
setting would drop, then enable it.

**Out of scope, deliberately:** topic-ifying the watchlist (article-set mechanisms
stay separate); filter UI on `/create`; change-tag/revert filtering (needs a second
EventStream); quarantine for config deliveries. LUI-84 remains the tracker for
deeper bot/platform unification.
