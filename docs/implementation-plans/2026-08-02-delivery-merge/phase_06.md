# Delivery Merge Implementation Plan — Phase 6: Per-subscription filters wired in

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** The volume knob live end to end: every delivery/subscription filters independently; fetch+render skipped when nobody wants the edit.

**Architecture (verified state):** edits flow `page-watch.js:694` listen → `:702 inspect(account, edit)` → `:625` isWatched + `topicIndex.topicsForEdit` → `:632` collapser → `:595 postEdit` → `sendStatus` (diff fetch ~422, render `:444`, subscription fan-out `:532` `deliverToTopics` → `deliverAll`). Filtering exists nowhere yet. Subscriptions table (`db/migrations/001-initial-schema.sql:61–75`) has no filter column; `lib/topic-store.js` CRUD is `addSubscription` (320–333), `subscriptionsForTopic` (335–341), `setSubscriptionStatus` (343–346), `removeSubscription` (348–350).

**Scope:** Phase 6 of 7. Depends on Phases 4 and 5.

**Codebase verified:** 2026-08-02 (investigator, delivery-merge worktree @ 815b016).

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge`.

---

### Task 1: Migration + topic-store support

**Files:**
- Create: `db/migrations/002-subscription-edit-filters.sql`

```sql
ALTER TABLE subscriptions ADD COLUMN edit_filters JSON NULL;
```

- Modify: `lib/topic-store.js` — `addSubscription` accepts optional `editFilters` (stored as JSON, null default); `subscriptionsForTopic` returns `editFilters` parsed (null when null); new `setSubscriptionFilters(subscriptionId, filters)`
- Test: `test/topic-store.test.js` (DB-backed, `describeWithDb` pattern)

**INVARIANT — do not fold `edit_filters` into topic filters:** `normalizeFilters`/`filtersHash` (`lib/topic-store.js:37,56`) hash *topic* filters for dedup. `edit_filters` is per-subscription and stays OUT of that hash — this is a considered design divergence, not an oversight. Add a test pinning it: two subscriptions on the same region with different `edit_filters` share one topic row.

**Steps:** failing tests (migration creates the column — assert via `information_schema.columns`; round-trip filters through add/read/set; null default; the shared-topic invariant test above) → implement → `SFEDITS_REQUIRE_DB=1 npx mocha test/topic-store.test.js test/db.test.js` green → commit.

### Task 2: Two-stage filtering in the pipeline

**Files:**
- Modify: `page-watch.js`
- Test: `test/fan-out.test.js` (extend), `test/posting.test.js`

**Prerequisite refactor — hoist consumer resolution above the fetch.** Today subscriptions are loaded inside `deliverToTopics` (`page-watch.js:358`, `store.subscriptionsForTopic`), which runs at line 532 — *after* the diff fetch (~422) and render (~444). Split it:

- New `resolveConsumers(account, edit, topicIds)` (in `page-watch.js` — `topicIds` is already a `sendStatus` parameter, and `account` is what holds the config deliveries), called at the top of `sendStatus`: returns `[...resolveConfigDeliveries(account), ...subscriptions for the matched topicIds]`, each carrying its `edit_filters` (subscription filters from `subscriptionsForTopic`, Task 1). Cache the subscription lookup per edit — don't query twice. Guard `topicStore === null` (no `topic_store` stanza) the same way `deliverToTopics` already does at page-watch.js:359 — config deliveries still resolve in that case.
- `deliverToTopics` becomes delivery-only: new signature takes the pre-resolved surviving subscription list (flat — each subscription belongs to exactly one topic, so the current `for (const topicId of topicIds)` load-and-deliver loop becomes a single loop over subscriptions, with result accumulation adjusted to match). Rate cap, quarantine, and `subscriptionHealth` bookkeeping stay exactly where they are today (quarantine in `deliverToTopics` at page-watch.js:380–389, rate cap in `subscription-delivery`) — filtering upstream changes only *which* consumers reach that code, it relocates nothing.
- **noop placement (load-bearing):** everything below `page-watch.js:420` sits inside `if (!argv.noop)`. `resolveConsumers()` and the metadata stage go **above** that guard, so `--noop` runs classification on real edits and prints the `filtered:` lines — that is exactly what Task 3's verification and the design's Definition of Done observe. In noop mode: resolve, filter, log every decision (drops and survivors), then return before the fetch/render/post block. Add a unit assertion that noop mode still produces filter logs (spy on the logger via the proxyquire pattern) so the ordering can't silently regress.

**Wiring (consumers = the resolved list):**

1. **Metadata stage — before diff fetch/render**: evaluate `passesMetadata(edit, consumer.edit_filters)` per consumer; drop failures from this edit's fan-out. If **none** survive, log and return before `fetchDiffHtml`/`captureDiffImage` — this is the volume/API win; assert it in tests via the existing proxyquire render-count pattern (`test/fan-out.test.js:31–49`).
2. **Content stage — after diff fetch, before render**: if any surviving consumer has `cosmetic_only` enabled (use `needsContentCheck`), compute `isCosmeticOnly(diffHtml)` **once** and drop those consumers when true. Again return early if none remain.
3. Every drop logs one line: `filtered: <page> for <consumer> (<reason>)` where consumer is the delivery type or `sub:<id>` — this is the observability the design requires for tuning.
4. The collapser stays upstream and unchanged (its aggregation semantics landed in Phase 4 Task 4).

**Tests to add:** mixed fan-out where a bot edit reaches only the consumer with `bots: true`; all-filtered edit performs zero renders; cosmetic-only edit dropped just for the `cosmetic_only` consumer; filter-less consumers unaffected.

**Steps:** failing tests → implement → suite green → commit.

### Task 3: SF defaults + live noop verification

**Files:**
- Modify: `config.base.json` — each of the three SF `deliveries` entries gets `"edit_filters": { "bots": false, "minor": false }`

**Steps:**

1. Commit the default.
2. Live verification (workflow rule: real data, not just unit tests):

```bash
timeout 300 node page-watch.js --noop --verbose 2>&1 | tee /tmp/claude-1000/-var-home-louie-Projects-Volunteering-Consulting-sfedits/e1cd9964-28d6-4795-b141-ccc5e5f27c81/scratchpad/noop-filters.log
```

Watch for: the watchlist sync line, real edits classified, `filtered: … (bot)` / `(minor)` lines appearing, non-filtered edits proceeding to (noop) render. Five minutes of the SF watchlist may be quiet — if no watched edit arrives, temporarily widen by pointing the local overlay `config.json` at a bigger watchlist for the check, and note that in the summary.

**Phase done when:** DB-backed tests prove per-subscription filtering, the zero-render test passes, and the noop run shows real edits being classified with reasons.
