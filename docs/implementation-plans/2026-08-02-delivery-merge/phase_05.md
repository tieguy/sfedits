# Delivery Merge Implementation Plan — Phase 5: Delivery unification

> **For Claude:** REQUIRED SUB-SKILL: Use ed3d-plan-and-execute:executing-an-implementation-plan to implement this plan task-by-task.

**Goal:** One typed delivery layer for accounts and subscriptions; posted log covers every delivery; revdel sweeps them all. After this phase there is exactly ONE code path that posts to Discord.

**Architecture (verified state):** account posting is three independent try/catch blocks in `page-watch.js:468–527` calling `lib/bluesky-platform.js`, `lib/mastodon-platform.js`, `lib/discord-platform.js` (each takes `{account, text, screenshot, metadata}`). Threading matters: `page-watch.js:469–511` passes Bluesky `replyTo` `{root, parent}` refs in and keeps `blueskyRef = {uri, cid}` from the result; `sendStatus` returns `{bluesky: blueskyRef, mastodon: mastodonId}` which `lib/edit-collapser.js:128–135` uses to thread burst follow-ups. `lib/subscription-delivery.js` (exports `deliver`, `deliverAll`, `validateWebhookUrl`, `isPermanentFailure`) has its own Discord webhook code and rejects non-Discord types (121–128). `lib/post-log.js:57–85` records `{host, revId, page, postedAt, blueskyUri, mastodonId, discordMessageId, status, missingCount}`, called only from `page-watch.js:543–547` — note: **once per entry in `edit.collapsedUrls`**, so revdeleting any constituent revision of a collapsed burst takes the combined post down; that guarantee must survive. `lib/revdel-check.js:108–160` tracks `blueskyDeleted`/`mastodonDeleted`/`discordDeleted` per entry so partial failures retry only the failed platform.

**Scope:** Phase 5 of 7. Depends on Phase 3 (composed config) and Phase 4 (filter shape, aggregated collapse fields).

**Codebase verified:** 2026-08-02 (investigator + reviewer, delivery-merge worktree @ 815b016).

**Working directory:** `/var/home/louie/Projects/Volunteering-Consulting/sfedits/.worktrees/delivery-merge`.

---

### Task 1: `lib/delivery.js` — typed handlers over the platform modules

**Files:**
- Create: `lib/delivery.js`
- Test: `test/delivery.test.js`

**Contract (threading-aware):**

```javascript
// delivery: { type: 'bluesky'|'mastodon'|'discord', credentials: Object,
//             template?: string, edit_filters?: Object, subscriptionId?: number }
// payload:  { text, screenshot, metadata, replyTo? }
//   replyTo: platform-specific reply refs, passed through untouched to the
//   platform module (Bluesky: {root, parent} record refs; Mastodon: in_reply_to id;
//   Discord: ignored). Mirrors what page-watch.js:469–511 passes today.
// returns:  { type, postId, ref } | null on handled failure
//   ref is what threading needs later: bluesky ⇒ {uri, cid}; mastodon ⇒ status id;
//   discord ⇒ message id. postId is the sweeper's handle (bluesky uri / mastodon id
//   / discord message id).
async function post(delivery, payload)

// Resolve account.deliveries[] entries against the account object (the composed
// config's accounts[0], which is what sendStatus already receives — config itself
// is local to main(), so the account is the right argument; do NOT add a
// module-scope config global).
// Entry shape: { type, credential_ref?, template?, edit_filters? };
// credential_ref defaults to the entry's type and names the account stanza
// holding that platform's credentials (post-Phase-3, secrets already overlaid).
function resolveConfigDeliveries(account)
```

`post()` dispatches to the existing platform modules unmodified and builds `ref`/`postId` from their returns. Unknown type throws. The Discord path calls `validateWebhookUrl` (import from `lib/subscription-delivery.js` for now; Task 2 re-homes it) — **never loosen or bypass the allowlist** (SSRF guard).

**Steps:** failing tests first (nock per platform, reusing mock shapes from `test/bluesky-client.test.js`, `test/discord-platform.test.js`, `test/posting.test.js`); implement; green; commit. Tests: dispatch + `{postId, ref}` normalization per platform; **replyTo pass-through** (nock body capture proves the Bluesky reply refs reach the wire); unknown type throws; `resolveConfigDeliveries` maps `credential_ref`; missing credentials stanza throws at resolve time.

### Task 2: Subscriptions post through the same layer

**Files:**
- Modify: `lib/subscription-delivery.js`
- Modify: `lib/delivery.js` (move `validateWebhookUrl` here; `subscription-delivery` re-exports it — same pattern as `delivery-limits` re-exported from `wikidata-claim-watch`)
- Test: `test/fan-out.test.js`, existing subscription-delivery tests (grep `subscription-delivery\|deliverAll` in `test/`)

`subscription-delivery.deliver()` keeps its orchestration — rate cap (`limiter.tryTake`), `isPermanentFailure`, drain summaries — but its actual webhook POST is replaced with `delivery.post({type: 'discord', credentials: {webhook_url}, subscriptionId}, payload)`. Delete the duplicated Discord posting code from `subscription-delivery`. **Quarantine bookkeeping does NOT move**: `subscriptionHealth.record` (page-watch.js:380/387) and `setSubscriptionStatus(..., 'broken')` (:389) live in `page-watch.js`'s `deliverToTopics` and stay there — Phase 6 only changes which subscriptions reach it, never relocates this logic. Also remove Task 1's temporary `validateWebhookUrl` import from `subscription-delivery` when re-homing it here, so the two modules don't require each other (end state: `subscription-delivery` requires `delivery`, one direction only). `deliver`/`deliverAll` return values now include the `{type, postId, subscriptionId}` results for each successful post (needed by Task 3); preserve existing return info callers rely on (grep call sites at `page-watch.js:372`).

**Steps:** failing/updated tests (fan-out behavior unchanged; results now carry postId + subscriptionId; allowlist still enforced — keep the existing rejection tests passing) → implement → green → commit. After this task: `grep -rn "discord.com" lib/ | grep -v delivery` shows no posting path outside `lib/delivery.js`/`lib/discord-platform.js`.

### Task 3: Account path through the layer + posted log covers every delivery

**Files:**
- Modify: `page-watch.js` (the 468–527 platform blocks and the 532–547 fan-out/record section)
- Modify: `config.base.json` (add `accounts[0].deliveries`: `[{"type":"bluesky"},{"type":"mastodon"},{"type":"discord"}]`)
- Modify: `lib/post-log.js`
- Test: `test/posting.test.js`, `test/fan-out.test.js`, post-log tests (grep `post-log` in `test/`)

**sendStatus refactor:** loop over `resolveConfigDeliveries(account)`, each delivery in its own try/catch (one platform's failure doesn't block the others — same isolation as today). Thread `replyTo` in from the collapser context exactly as the current per-platform code does, and return the same shape the collapser consumes (`{bluesky: {uri, cid}, mastodon: id}`, built from the `ref`s) so `edit-collapser.js:128–135` keeps threading bursts — **do not change the collapser's consumption contract**. A delivery-level `template` overrides `account.template` in the `getStatus` call.

**Recording stays in `page-watch.js`, after fan-out** (subscription-delivery has no diff URL — `recordPost` derives `host`/`revId` from it, `lib/post-log.js:66`). Collect results from config deliveries and from `deliverAll` (Task 2), then record **one entry per `edit.collapsedUrls` entry** (preserving the current burst guarantee at 543–547), new shape:

```javascript
{ host, revId, page, postedAt, status: 'active', missingCount: 0,
  deliveries: [ { type: 'bluesky', postId, deleted: false },
                { type: 'discord', postId, subscriptionId, deleted: false } ] }
```

`subscriptionId` only on subscription deliveries (sweeper resolves the webhook at sweep time; webhooks rotate and live in the DB). Add `entryDeliveries(entry)` to `lib/post-log.js`: yields the array form from either the new shape or the legacy fields (`blueskyUri`/`mastodonId`/`discordMessageId` + their `*Deleted` flags) — `data/posted-log.jsonl` on a running instance has old entries. Use it for all reads.

**Steps:** failing tests (three platform posts from one render; per-platform failure isolation — a Bluesky 500 doesn't stop Mastodon; burst threading still works — port/keep the existing threading test; entries written per collapsed URL with the deliveries array incl. subscription results; accessor reads both shapes) → implement → green → commit.

### Task 4: Revdel sweeps all deliveries

**Files:**
- Modify: `lib/revdel-check.js`
- Modify: `page-watch.js` `main()` (~689) to pass the topic store handle it already constructs
- Test: existing revdel test file (grep `revdel` in `test/`)

The delete loop iterates `entryDeliveries(entry)`. Per-delivery retry state lives on each array element's `deleted` flag (replacing `blueskyDeleted`/`mastodonDeleted`/`discordDeleted` for new-shape entries; the accessor maps legacy flags); the entry is marked fully deleted only when **every** delivery's flag is true, and a partial failure retries only the still-false deliveries — the exact semantics of today's 110–160. Discord deletes: `subscriptionId` absent ⇒ account webhook (`account.discord.webhook_url`, as today); present ⇒ look up the subscription via the topic store and use its `delivery_config.webhook_url`; missing/deleted subscription logs and marks that delivery `deleted` (nothing left to delete).

**Steps:** failing tests (mixed entry — account bluesky + subscription discord — sweeps both; partial failure retries only the failed delivery; missing subscription skips without throwing; legacy-shape entry still sweeps) → implement → full suite green (`SFEDITS_REQUIRE_DB=1 npm test`) → commit (`feat: unify delivery layer; posted log and revdel cover subscription posts`).

**Phase done when:** all platforms and subscriptions post through `lib/delivery.js` (grep proves one Discord path), burst threading still passes, mixed-sweep and partial-retry tests pass, suite green.
