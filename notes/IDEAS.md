# sfedits — idea stack from 2026-07-12 session

Context: three PRs shipped against `mrfinnsmith/sfedits` (via `tieguy` fork):

- **PR #1** — compare-API diff rendering, wikitext stripping, mechanical alt text (`readable-diff-images`)
- **PR #2** — lead image + Wikidata description in headers, CJK fonts in Docker (`article-header-images`, stacked on #1)
- **PR #4** — revdel sweeper: delete social posts when their revision is hidden on-wiki (`delete-hidden-revisions`, independent; see §8)

Everything below except §8 is *not yet built* — captured for the Finn conversation and future nights.

---

## 1. Post-text enhancements (outside the image)

Current template: `{{page}} Wikipedia article edited by {{name}} {{url}}` (per-account in config.json).

- **Wikidata description in text** — already fetched for the image header; ~30–50 chars. Highest value/risk ratio; text is searchable and screen-reader-first.
- **Compact change hint** — for small edits: `"mandate" → "passport"`. ~2/3 of the 30-post batch would qualify. High engagement value.
- **Editor's edit summary** (`edit.comment` from wikichanges) — informative but **NOT currently PII-screened** (only diff text is). Must wire comments into screening before use.
- ⚠️ **Facet bug waiting**: `buildFacets` locates page/user names as substrings; excerpts containing the article name would misplace links. Fix facets before adding excerpts.
- Bluesky budget: 300 graphemes; current posts ~140. Truncation priority: URL > page > hint > description.

## 2. Revert-risk badge (LiftWing)

- Issue draft + mockup ready to paste: `ISSUE_revert_risk.md` + `mockup-revert-risk.png` in this directory.
- Model: `revertrisk-language-agnostic:predict` (anonymous POST, rev_id + lang, ~1s, all languages).
- Calibration on real posts: blatant vandalism 95%, subtle vandalism 60%, benign typo fix 38% → high threshold (≥85%) required; gray zone 40–80% is noisy.
- Safest first step: score in admin console + logs only (uncontroversial). Public badging is a bot-voice/ethics call for Finn.
- Related follow-up idea: reply to a post when the edit is later actually reverted (observed fact > prediction). Bigger build: track posted revisions, watch for reverts.

## 3. Wikidata-driven watchlist

- Today: config.json exact-title map per wiki, hand-maintained across languages, breaks silently on renames.
- **Sitelinks work great**: Gavin Newsom = Q461391 → titles on 50 wikis incl. `개빈 뉴섬`. One Q-id per entity, auto-expanded, rename-proof.
- **Position-held SPARQL is untrustworthy**: "current members of SF Board of Supervisors" (P39 = Q116005093, no P582 end date) returned 7 people for 11 seats, including Ross Mirkarimi (left 2012) and 19th-century names, missing actual sitting members (Walton, Mandelman). Missing end dates + missing statements.
  - Louie intends to fix the Wikidata data itself (separate night).
- Architecture that survives the data: human-curated Q-id list → sitelink expansion → optional category-based audit.
- **Criteria-as-source empirically killed (2026-07-22)**: union of 6 structural criteria (P131+/P159/P19/P937/P276/P39-jurisdiction against the 9 Bay Area counties) covers only 273/503 of the task force Top+High list — misses the editorially curated half (Kerouac, Grateful Dead, Dot-com bubble, gold rush). Unfiltered, the same criteria pull ~10k enwiki articles (~20×). A ≥25-sitelink notability filter gets volume back to ~500 but deletes the civic core (SF Board of Supervisors: 6 sitelinks, London Breed: 18). Analysis artifacts (Q-id map, coverage matrix, missed list) in the 2026-07-22 session scratchpad.
- **Pivot (2026-07-22, building)**: instead of watchlist-from-Wikidata, notify on Wikidata *claim changes* that add/remove a Bay Area connection (P19/P20/P131/P159/P276/P937 + P39 with SF-jurisdiction positions). Property+value are parseable from the EventStreams edit comment (`[[Property:P19]]: [[Q62]]`) — no per-event API calls. Match values against a precomputed chained place set (P131+ into the 9 counties, refreshed like the watchlist). Rate-capped, bot edits included.
- **TODO (Louie)**: use the Wikidata vector database / embedding search to discover *other* properties that semantically connect entities to SF (beyond the hand-picked place props) — e.g. narrative location, filming location, named-after.

## 4. enwiki categories (audit tool, not source of truth)

- `San Francisco Board of Supervisors members` covers 7/12 known watched articles; `Mayors of San Francisco` 4/12.
- Categories are all-time membership (would ~10× the list); enwiki-only. Use as periodic "did we miss anyone" report (PetScan intersection with Living people), not as the watchlist.

## 5. Toolforge multi-tenant service ("edits bot for any topic")

**Prior art — the niche is open**: anon/congressedits (single-tenant, self-hosted; congressedits died twice — Twitter 2018, botsin.space shutdown 2025), codemonauts/wikiwatch (EventStreams anon successor, still single-tenant), Hatnote's Wikipedia IFTTT channel (hosted per-article triggers, text-only, no rendering). Nothing hosted + multi-tenant + rich rendering.

**Architecture sketch**:
- One EventStreams (SSE `recentchange`) consumer for all tenants — single connection, hash-lookup matching (~30–50 events/s total firehose).
- Web UI: Wikimedia OAuth, feed = topics (Q-ids → sitelink expansion) + template.
- Render/post workers: the PR #1/#2 pipeline.
- ToolsDB for configs + posted log.

**Frictions**: Chromium is heavy for Toolforge quotas — consider swapping Puppeteer for satori/resvg (our HTML is simple; ~10× memory cut). PII screening must be mandatory + shared. Abuse/BLP: self-serve amplification of edits to a person's article is a harassment vector wearing a transparency costume — needs rate caps, visible operator, possibly feed review.

**Cheap first step**: renderer-as-a-service on Toolforge — `GET /render?diff=<url>` → PNG + alt text. No credentials, no abuse surface, immediately useful to every anon-style bot operator.

## 6. Service-owned Bluesky accounts (reverse credential model — Louie's idea)

- Service *creates* bot accounts instead of users handing over credentials. Handle scheme: `botname.langcode.edits-on-bluesky.org`. No human access to credentials by default; kill switch inherent; creator↔bot registry public.
- **PDS question**: custom handles don't require a PDS (DNS TXT per handle), but automated account creation on bsky.social fights you (email verification, CAPTCHA, IP rate limits). **Own PDS is the natural fit**: createAccount under service control, handles auto-issued, keys never leave the service, small footprint (single container, SQLite per account), federates with main AppView. AT-proto portability = accounts can later be handed to their creators via key rotation.
- **Verify before committing**: Bluesky relay caps accounts from unrecognized PDSes (increase is requestable); current bot-disclosure norms (templated bios: "Automated · created by User:X · opt-out link").
- Gate creation via Wikimedia OAuth + edit-count threshold (e.g. extended-confirmed), block/lock check. Inherits Wikipedia's trust infrastructure.
- Mastodon equivalent = running an instance; defer, ship Bluesky-only.

## 7. PII screening: LiftWing gap + open-weights models

**LiftWing has no PII model** (verified 2026-07: catalog is revert-risk ×3, quality/topic scorers, langid, article-descriptions, logo detection, article-country).

**Existing on-wiki PII automation (surveyed 2026-07) — the gap is real**:
- **AbuseFilter/edit filters** are the only automation: regex at save-time, human-maintained. Email addresses disallowed/tagged on enwiki; phone-number filtering debated but stuck on international formats; anti-doxxing filters exist but have a documented meta-problem — the private filter rules and their logs *contain* the PII they block, requiring manual oversighter suppression of the logs themselves (2023 Community Wishlist asked for oversighter-only filters).
- **Oversight/suppression is entirely manual** — humans race doxxing in real time.
- **ClueBot NG / ORES / revert-risk**: vandalism-focused; catch PII only incidentally.
- **Edit Check has no privacy check** existing or planned (checks: reference, link/reliability, paste, tone; June 2026 LLM research is about hallucinated refs).
- **No Toolforge tool or community bot dedicated to PII detection found.**

This upgrades the WMF pitch from "host a model" to "here are three consumer workflows for it": (a) an oversight-alerting watcher bot (ClueBot-for-PII — streams recentchanges, scores, alerts oversighters *privately*; addresses the documented manual-suppression pain), (b) republisher bots like sfedits, (c) a future Edit Check personal-details warning. ⚠️ Design constraint: a PII detector's output is itself sensitive — a public feed of "this edit contains PII" is a doxxing treasure map. Alerts must go to private channels only.

**Open-weights small-model landscape (researched 2026-07-12, deep pass)**:

| Model | Size | License | Languages | HF Inference Providers? | Notes |
|---|---|---|---|---|---|
| **GLiNER2-PII** (fastino/gliner2-privacy-filter-PII-multi) | 205M | Apache-2.0 | 7 (European only — **no Korean**) | **No** — requires custom `gliner2` library, self-host only | 42 entity types, span-level; best span-F1 on SPY benchmark (arXiv 2605.09973) — but only 0.478 avg on Sikkema's cross-domain suite |
| **Piiranha v1** (iiiorg) | mdeberta-v3-base (~86M active) | ⚠️ **CC-BY-NC-ND** — non-commercial, NO derivatives | 6 | **No** | Best avg F1 (0.542) on Sikkema suite but wildly unstable (0.169–0.780 per dataset). **License disqualifies it for WMF hosting and probably any redistribution/fine-tuning** |
| **GLiNER multi-pii v1** (urchade) | 209M | Apache-2.0 | 6 | **No** — custom `gliner` library | Most *consistent* on Sikkema suite (0.455–0.607, avg 0.535); zero-shot flexible entity types |
| **Llama Guard 3** (Meta — the "Meta released something" memory) | 1B–8B | Llama license (not OSI) | 8 | (some providers serve Llama Guard) | LLM classifier; Privacy = S7 in MLCommons taxonomy; message-level, not span-level; license + granularity both wrong for this use |
| Presidio (current sfedits) | framework | MIT | en-centric default | n/a (framework) | 0.481 avg on Sikkema suite, 15ms latency, 8–11× faster than transformers; pluggable NER backends |

**HF serving bottom line**: none of the three PII models are on HF's serverless Inference Providers; the GLiNER family needs its custom library even on paid dedicated Inference Endpoints (custom handler). In practice irrelevant for both use cases: 200M models run fine on CPU for benchmarking, and LiftWing self-hosts via KServe anyway.

**Benchmark reality check (Sikkema, June 2026 — 4 datasets × 2 languages, 6 shared entity types)**: best average F1 is only **0.542**; every open model degrades hard out-of-distribution; commercial claims of 0.92–0.99 don't survive cross-domain either. His conclusion: pick Presidio for the *infrastructure* and swap detection models inside it. Follow-up post promised: plugging the better models into Presidio.

**RECAP paper (arXiv 2510.07551)**: hybrid = deterministic regex + context-aware LLM refinement, 3-phase pipeline; 13 low-resource locales, 300+ entity types without retraining; +82% weighted-F1 vs fine-tuned NER, +17% vs zero-shot LLMs. Notable: **sfedits' existing Presidio+Gemini architecture is accidentally this exact SOTA pattern.** The LLM-in-the-loop makes it awkward for LiftWing hosting, but it reframes the sfedits stack as validated, not a hack.

**The plan worth pitching to WMF (revised — Louie's point: sfedits logs alone prove nothing)**:
1. Evaluate on **public multi-domain benchmarks** (AI4Privacy, Nemotron-PII, Gretel Finance, CoNLL — Sikkema's harness is reproducible) **plus a new wikitext/diff test domain** built from Wikipedia data; sfedits logs become a small supplementary real-world validation set, not the foundation.
2. Candidates: GLiNER2-PII and GLiNER multi-pii (both Apache-2.0) inside Presidio's framework; **drop Piiranha (license)**.
3. Write up cross-domain results incl. the wikitext domain; attach to a Phabricator model-hosting proposal (open weights + model card required). Honest framing: cross-domain F1 ~0.5 means "screening aid," not "guarantee" — matches how sfedits uses it (flag → verify → block-on-doubt).
4. Ally: WMF Edit Check project has explored personal-detail warnings — same model serves their roadmap.
5. Side benefit regardless of WMF: best Apache-2.0 model inside Presidio could replace sfedits' Gemini fallback.
6. Gaps to flag in proposal: no CJK coverage in any current small open model (sfedits watches ko wiki); wikitext markup is exactly the out-of-distribution domain these models fail on — which is the argument *for* a Wikimedia-specific eval + possible fine-tune (Apache-2.0 allows it; NC-ND doesn't).

## 8. Hidden/suppressed edits — a gap in sfedits TODAY (and every anon-style bot)

Two levels on-wiki: **RevisionDelete** (admins hide text/user/summary; logged publicly) and **suppression/oversight** (hidden even from admins; log is private). The failure mode for republisher bots: an edit gets posted, then the community suppresses it (often *because* it's PII/defamation) — but the bot's social post preserves it forever. sfedits currently has no post-deletion logic; neither did congressedits.

**What exists to monitor**:
- `mediawiki.revision-visibility-change` — public EventStream (verified 2026-07 in the stream catalog) emitting revdel visibility changes with before/after visibility flags.
- Full oversight suppression is NOT reliably announced publicly (announcing "something was suppressed here" is itself a leak), so stream-watching alone is insufficient.

**Robust pattern for any republisher bot**: keep a log of posted rev_ids → (a) subscribe to revision-visibility-change and delete the social post when a posted revision is hidden; (b) belt-and-braces: periodically re-fetch posted revisions via API and delete posts whose revisions come back `texthidden`/`suppressed`/absent. A *requirement* for the multi-tenant service.

**✅ BUILT (2026-07-13) as draft PR #4** (`delete-hidden-revisions`, off main, merges independently): polling-only (streams can't see suppression), 20-min sweeps over 30 days of posts logged in `data/posted-log.jsonl`. Asymmetric evidence: affirmative hidden flags delete immediately (incl. `userhidden` — post text names the editor); missing revisions need two consecutive sweeps. Verified live against a real revdeleted revision. Moves/draftification confirmed harmless (revids follow renames); known residual false-positive: temporary deletion (delete-then-restore) loses the post.

## 9. Watchlist from the SF Bay Area task force (all Bay Area articles)

Task force tags talk pages → assessment categories are enumerable via `categorymembers` (strip `Talk:`). Counts (2026-07-13): **~14,100 articles** total; Top-importance 68, Top+High ~500, Mid ~1.9k, Low ~9.3k. Implementation: a "category source" in config materialized to the title map, refreshed daily (~100-line patch); matching stays a hash lookup.

Volume math kills the naive version: 14k articles ≈ 250–600 posts/day (unfollowable; Bluesky ceiling ~1.6k/day; PII review queue swamps a human). Viable filters, composable:
1. **Top+High only** (~500 articles → ~10–30/day) — sweet spot.
2. **IP/anon edits only** across all 14k (congressedits spirit; `edit.anonymous` already in wikichanges events).
3. **Revert-risk gate** (§2) across all 14k — "Bay Area vandalism watchdog."
4. Long game: this is the topic-feed use case for the Toolforge multi-tenant service (§5).

E.g. all-edits-for-Top+High + suspicious-only-for-the-rest = one good account.

## 10. Fork hosting: integration branch (2026-07-13)

Decision direction: host our own fork rather than wait on upstream merges. Local branch
`integration` merges everything: main + PR#1 (rendering) + PR#2 (headers) + PR#4 (revdel)
+ Louie's `claude/wikipedia-dynamic-article-list-cnbg4q` (PageAssessments watchlists + Discord),
plus three new commits:
- **f2164dc** — fixes from review: PageAssessments project name is `California/San Francisco
  Bay Area task force` (template had a name that silently returned 0 articles); zero-article
  fetches now treated as failures so they can't wipe a working watchlist.
- **b8ea7dc** — revdel sweeper covers Discord (webhook message DELETE; 404=success; missing
  webhook config completes with warning).
- **d40210a** — rich Discord embeds: title + Wikidata description, editor link, change counts,
  quoted added/removed excerpts, lead-image thumbnail, screenshot, color-coded (green/red/blue),
  alt text on the attachment. Falls back to plain markdown on the fallback screenshot path.
- **action links commit** — per Louie, Discord is patrol-shaped: Actions row of on-wiki links —
  Undo (preloaded revert via `action=edit&undo=&undoafter=`), History, Editor talk (warnings),
  Watch. Rollback/Thanks impossible via URL (need tokens). Parens in titles now escaped in
  embed markdown URLs. Undo caveat: link only works while the edit is still undoable.
Later additions (2026-07-13, same branch):
- **BLP flagging** (f98bb7b, 2e973b8): Wikidata P31=Q5 + no P570 (or death within 2y WP:BDP
  window) → shield badge on Discord embed + BLP/N action link + Wikidata item link (the fix
  path when a dead person flags as BLP = missing death date). Language-agnostic, fail-soft.
- **Native renderer** (00613f4): buildDiffModel + satori/resvg — no Chromium, ~370ms/image,
  puppeteer now optional (lazy). Bundled latin Noto fonts (OFL); CJK runtime-fetched+cached.
  Unblocks Toolforge. Both renderers share the model; HTML output unchanged.
- **EventStreams** (b58ecd3): lib/edit-stream.js replaces wikichanges IRC — same edit shape
  and feed names, Last-Event-ID resume, one connection for all wikis. Verified live.
- PII rip-out for fork = config only: `pii_blocking.enabled: false` (no code change; just
  don't deploy a PII service on Toolforge; revdel sweeper is the backstop).
- Upstream-able slices: edit-stream is standalone (PR against main); the renderer rides on
  PR#1's compare-diff (follow-up PR once #1 lands).
188 tests passing. Pushed to fork as `integration` (2026-07-13) — the deployable base for Toolforge.

Watchlist strategy (per Louie): drop the hard-coded list; fix coverage on-wiki instead.
Gap analysis of all 45 historically-posted articles is in `SFBA-TAGGING-EDITS.md` (this dir):
only 3 untagged; ~16 need sfba-importance filled/corrected (Lurie: sitting mayor rated Low!).
⚠ methodology: PageAssessments queries need `pasubprojects=true` or task-force tags are invisible.
Suggested config: Bluesky/Mastodon account Top+High (~503 articles), Discord account
Top+High+Mid (~2,450, ~50–120 posts/day).

## 11. es-wiki coverage (wishlist, 2026-07-13)

Goal: watch Spanish Wikipedia articles too, posting to a separate Discord channel.

**No companion install needed** — the existing architecture does this in one process:
- wikichanges' IRC feed already carries all wikis; matching is per-account by feed name
  ("Spanish Wikipedia").
- The `accounts` array supports a second stanza: es watchlist + its own `discord.webhook_url`
  (and no bluesky/mastodon) → separate channel, same bot.

**The real gap**: eswiki has NO PageAssessments extension (verified 2026-07-13: `list=projectpages`
unrecognized), so dynamic task-force watchlists don't work there. Options:
1. **Elegant**: derive es titles from the enwiki SFBA task force list via Wikidata sitelinks —
   one source of truth (the task force), es titles resolved automatically, rename-proof.
   Fits the existing watchlist-sync refresh loop as a second resolution step.
2. Static es list in config (boring, works today).
3. eswiki wikiproyecto talk-page categories (eswiki has its own assessment categories; would
   need a category-source mode).

Also fine already: BLP check is Wikidata-based (language-agnostic ✓), REST summary gives
localized descriptions ✓, per-account Mustache template can be Spanish ✓. Weak spot: PII
screening is en-tuned (Presidio spaCy en model); GLiNER2-PII supports Spanish — ties into §7.

---

## Loose ends

- **Editor-count metric #5: TRIED AND REJECTED (2026-07-23). Reassessment stays at four
  metrics.** Don't rebuild this without reading the numbers below — all three variants were
  implemented, run against the full 14,814-article cohort, and backed out (`git checkout`; the
  four-metric `report.md` was regenerated). Goal was to separate "one person's passion project"
  from "important to many Bay Area editors". Three distinct quantities got conflated, and none
  works:
  - **Crowd size** (count of an article's editors who also edit other task-force articles):
    r = **0.960** with the raw editor count — it's a fame/size proxy, exactly what significance
    is designed to exclude. Tightening "regular" to ≥50 cohort articles only reaches 0.888; the
    regulars pool is 68k of 453k distinct editors, so on any big article nearly everyone
    qualifies. Effect: 31/60 promote candidates changed, tilting to well-known places (16 "X,
    California" cities, Oracle Park, De Young) and pushing off civic institutions (SF
    Baykeeper, SF Arts Commission, Oakland City Council, SFMTA). Demote side moved only 6/60.
  - **Crowd purity** (shared/(editors+10), scale-free, r = 0.055): floods promote with **47 of
    60 transit stations** — BART/Caltrain/VTA/Muni stubs are edited almost exclusively by Bay
    Area rail regulars, so they max out any purity measure. Not a tuning problem: geometric
    mean of count×purity gives 31 stations, and the residual of shared regressed on raw gives
    44. Purity does work on the DEMOTE side (it caught Green Day, Lucasfilm, Pixar, Journey,
    Jim Jones, Gap Inc., Treaty of San Francisco — famous SF-connected topics whose crowd
    isn't an SF crowd), which is the only version worth reviving.
  - **Edit concentration** (top editor's share — the literal passion-project test): measured on
    a 24-article sample. The intuition that transit stubs are few-people-many-edits is FALSE:
    stations average top-editor 14%, top-5 33%, 132 distinct editors at 2.4 edits each. The
    genuinely concentrated articles are the civic institutions the four-metric list already
    promotes — SF Baykeeper (23 editors, top editor 25%, top-5 67%), SF DPW (36%), SF Board of
    Education (top-5 66%), Oakland City Council (35%). So inverse-concentration would push
    civic institutions OFF the promote list and lift cities, the opposite of the intent.
    Cohort-wide numbers would need a re-crawl storing per-editor revision counts.
  - Crawl mechanics that DID work, if any of this is ever revisited: `prop=revisions,
    rvprop=user|timestamp, rvlimit=max`, paginating only while the oldest revision seen is
    inside the 5-year window ("500 revisions or 5 years, whichever reaches further back"), bots
    filtered by `/bot$/i`, IPs skipped (can't be tracked across articles). ~2.5-3 articles/sec,
    ~1.5h for the cohort. The resulting name lists are still on disk at
    `data/reassess/editors.json` (18MB, gitignored, inert — nothing reads it now); purity and
    size variants are computable from it without re-crawling, concentration is not.

- **NEXT UP: Toolforge deployment** (Louie's developer-account issue is fixed as of 2026-07-18;
  deployment happens in a fresh session). All code prerequisites are done on the fork's
  `integration` branch. Remaining is ops: create tool at toolsadmin → `toolforge envvars create
  SFEDITS_CONFIG` (full config JSON; see lib/config.js) → build-service build → continuous job
  (bot) + webservice (admin console). No PII service (config `pii_blocking.enabled: false`);
  revdel sweeper is the backstop. See §12-ish deployment mapping in the sfedits repo's local
  CLAUDE.md.
- **Local CLAUDE.md exists** in the sfedits checkout (gitignored, 2026-07-13): remote topology
  (origin read-only / fork pushable), branch map, workflow rules, deployment status, and the
  session's hard-won gotchas (pasubprojects, byte offsets, sentinels, satori tokenization,
  heartbeat-irc naming, etc.). Update its "Last verified" date when branch map or deployment
  status changes.
- 30 batch-rendered images from the account's post history in session scratchpad (ephemeral) — regenerate with the batch script if needed; only ~8 were visually reviewed.
- Three PRs open (as of 2026-07-13): #1 rendering (marked ready, no longer draft), #2 headers (draft, stacked — its diff includes #1's commit until #1 merges), #4 revdel sweeper (draft, independent). PR number 3 was taken by something else in the repo — possibly the revert-risk issue.
- Local Chrome for Puppeteer: manual unzip was needed at `~/.cache/puppeteer` (installer's extraction fails silently on this box).
- Vandalism spotted mid-session: London Breed "mandate→passport" (rev 1363663913) — was still live when observed; worth checking it got reverted.
