#!/usr/bin/env node

/**
 * Algorithmic reassessment of SFBA task force importance ratings.
 * LOCAL tool - never deployed to Toolforge, never run by the bot.
 *
 * Design: significance = percentile rank of CANONICAL INLINKS - how many other
 * task-force articles link here, counting only links written in an article's own
 * wikitext (no navbox/template links) and resolving redirects to canonical
 * titles. That single measure reaches r=0.520 against 11,778 human importance
 * ratings. It replaced a median-of-four-percentiles composite that reached only
 * 0.282 - the composite scored worse than its own best ingredient.
 *
 * The other quantities are still computed and reported as EVIDENCE for a human
 * reading the output, but no longer enter the score:
 *   entangle   - Wikidata statements tying the item to a Bay Area place/office.
 *                Adds +0.0006 R^2 over inlinks. Blind to events and eras, which
 *                have no location property.
 *   lead       - how early the lead mentions a Bay Area term. Adds +0.0000.
 *                Substantially detects "a place name is in the title". Still
 *                essential as a RELEVANCE gate outside this cohort (see below).
 *   exclusive  - 1/(1+N other WikiProjects). Correlates -0.082, i.e. backwards:
 *                important topics attract MORE WikiProjects. Never score on it.
 *   pageviews  - +0.0060 over inlinks. Reported as evidence only; making it a
 *                metric would change the standard, not improve accuracy.
 *
 * SCOPE WARNING: those verdicts hold for reassessing the ALREADY-TAGGED cohort,
 * which humans pre-filtered for Bay Area relevance. On an unfiltered pool
 * (e.g. untagged Wikidata candidates) inlinks alone surfaces Microsoft and
 * UC Davis - articles Bay Area pages merely mention a lot - and `lead` is what
 * excludes them. Ranking and relevance are separate jobs.
 *
 * Full analysis, including nine rejected ideas and why:
 *   docs/importance-ranking-methodology.md
 *
 * Output is boundary churn only: top demote candidates (currently Top/High,
 * low significance) and top promote candidates (currently Mid/Low/unrated,
 * high significance). Expensive per-article data (total inlink denominators,
 * 12-month pageviews) is fetched only for those candidates.
 *
 * Usage: node scripts/reassess.js <stage>|all
 * Stages: cohort qids links links-prose links-prose-all redirects claims
 *         assessments leads denoms score report
 * Caches: data/reassess/<stage>.json (delete a file to force a re-fetch)
 */

const fs = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data', 'reassess')
const EN_API = 'https://en.wikipedia.org/w/api.php'
const WD_API = 'https://www.wikidata.org/w/api.php'
const PROJECT = 'California/San Francisco Bay Area task force'
const UA = 'sfba-reassess/0.1 (https://san-francisco-edit-stream.toolforge.org; luis@lu.is)'
const CANDIDATES_PER_DIRECTION = 60

// Terms whose appearance early in the lead marks a defining Bay Area
// connection. Deliberately conservative: ambiguous names (Richmond,
// Santa Rosa) are omitted; a few mild false-positive risks (Menlo Park,
// Mountain View) are accepted since the metric is one voice of four.
const BAY_AREA_TERMS = [
  'San Francisco', 'Bay Area', 'Silicon Valley', 'Oakland', 'Berkeley',
  'San Jose', 'San José', 'Palo Alto', 'Stanford', 'Marin County',
  'Sausalito', 'Napa', 'Sonoma', 'Santa Clara', 'San Mateo', 'Alameda',
  'Contra Costa', 'Solano', 'Golden Gate', 'Cupertino', 'Mountain View',
  'Menlo Park', 'Redwood City', 'Sunnyvale', 'Fremont, California',
  'Vallejo', 'Hayward', 'Daly City', 'Emeryville', 'Mission District',
  'Haight-Ashbury', 'Presidio', 'Golden State Warriors', 'Alcatraz', 'Caltrain'
]
const BAY_AREA_RE = new RegExp(`(${BAY_AREA_TERMS.map(t =>
  t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`)

// ---------------------------------------------------------------- helpers

function cachePath(stage) { return path.join(DATA_DIR, `${stage}.json`) }

function loadCache(stage) {
  const p = cachePath(stage)
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}

function saveCache(stage, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(cachePath(stage), JSON.stringify(data))
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

async function apiGet(base, params, {
  tries = 4, backoffMs = 2000, rateLimitWaitMs = 10000, maxRateLimitWaits = 60
} = {}) {
  const url = new URL(base)
  for (const [k, v] of Object.entries({ format: 'json', maxlag: 5, ...params })) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  // Replication lag and rate limiting are not failures - the API is asking us to
  // slow down. Both are waited out without consuming retry attempts, because a
  // sustained 429 outruns a 4-attempt exponential backoff and kills hour-long
  // runs partway through (learned the hard way at 10,000/14,823 articles).
  let lagWaits = 0
  let limitWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (res.status === 429) {
        if (limitWaits >= maxRateLimitWaits) throw new Error('HTTP 429')
        limitWaits++
        // Retry-After is authoritative when the server sends it.
        const after = Number(res.headers.get('retry-after'))
        await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : rateLimitWaitMs)
        continue
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error.code === 'maxlag' ? 'maxlag' : `API error: ${data.error.code}`)
      return data
    } catch (error) {
      if (error.message === 'maxlag' && lagWaits < maxRateLimitWaits) {
        lagWaits++
        await sleep(rateLimitWaitMs)
        continue
      }
      if (attempt >= tries) throw error
      attempt++
      await sleep(backoffMs * attempt)
    }
  }
}

function* batches(arr, size) {
  for (let i = 0; i < arr.length; i += size) yield arr.slice(i, i + size)
}

/** Map every value to its percentile rank (0..1) with ties averaged. */
function percentileRanks(values) {
  const indexed = values.map((v, i) => ({ v, i }))
  indexed.sort((a, b) => a.v - b.v)
  const ranks = new Array(values.length)
  let pos = 0
  while (pos < indexed.length) {
    let end = pos
    while (end + 1 < indexed.length && indexed[end + 1].v === indexed[pos].v) end++
    const avgRank = (pos + end) / 2
    for (let j = pos; j <= end; j++) {
      ranks[indexed[j].i] = values.length > 1 ? avgRank / (values.length - 1) : 0.5
    }
    pos = end + 1
  }
  return ranks
}

/** Median of an array (average of middle two when even). */
function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * 0..1 score for how early the lead mentions a Bay Area term.
 * 1 = first character, ~0 = end of lead, 0 = never mentioned.
 */
function leadScore(text) {
  if (!text) return { score: 0, term: null }
  const m = BAY_AREA_RE.exec(text)
  if (!m) return { score: 0, term: null }
  return { score: 1 - m.index / Math.max(text.length, 1), term: m[1] }
}

// Wikilinks written literally in an article's own wikitext. Deliberately NOT
// prop=links: that reads the pagelinks table, which is the rendered link set
// and therefore includes every link a transcluded navbox emits. Measured on
// live articles, 92-97% of a BART station's links come from templates, versus
// 45-77% for a company or a person - so navbox links do not merely inflate the
// inlink metric, they inflate it hardest for exactly one class of article.
const WIKILINK_RE = /\[\[([^[\]|#]+)/g
const NON_ARTICLE_NS = /^:?\s*(File|Image|Category|Media)\s*:/i

// References are not topical links. Citation templates wikilink the publication
// - {{cite web |work=[[TechCrunch]]}} - so counting them treats every footnote as
// evidence that the citing article is ABOUT that publication. Measured: ~93% of
// TechCrunch's inbound links are of this shape (57 of 61 on Instagram alone),
// which floated six media outlets into the proposed top 46. Same failure as
// navbox links: structure masquerading as relevance.
const REF_BLOCK_RE = /<ref\b[^>]*\/>|<ref\b[^>]*>[\s\S]*?<\/ref>/gi
const CITATION_TEMPLATE_RE = /\{\{\s*(cite[ _][^|}]*|citation|refn|sfn|harv[^|}]*)\s*(\|[\s\S]*?)?\}\}/gi

/**
 * Set of mainspace link targets present in raw wikitext, normalized the way
 * MediaWiki normalizes titles (underscores to spaces, leading capital) so the
 * results can be matched against cohort titles.
 */
function wikitextLinks(text) {
  const targets = new Set()
  if (!text) return targets
  const prose = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(REF_BLOCK_RE, '')
    .replace(CITATION_TEMPLATE_RE, '')
  for (const match of prose.matchAll(WIKILINK_RE)) {
    const target = match[1].replace(/_/g, ' ').trim().replace(/^:\s*/, '')
    if (!target || NON_ARTICLE_NS.test(match[1].trim())) continue
    targets.add(target.charAt(0).toUpperCase() + target.slice(1))
  }
  return targets
}

/**
 * Fold prose-link counts onto canonical titles, resolving redirects.
 *
 * Wikitext links name whatever title the editor typed, so an article with many
 * redirects has its inbound links scattered across them. That is not a rounding
 * error: redirect count scales with importance (Top/High average 17-18
 * redirects, Low averages 1), so ignoring redirects undercounts links in
 * proportion to how significant an article is. Measured cohort-wide, 14% of
 * link edges were being discarded, and California gold rush went from 63 to 345
 * inbound links once they were recovered.
 *
 * Cohort articles with no inbound links are reported as 0 rather than omitted;
 * targets absent from the redirect map cannot be resolved and are skipped.
 */
function canonicalInlinks(counts, redirects, cohortTitles) {
  const cohortSet = new Set(cohortTitles)
  const totals = {}
  for (const title of cohortTitles) totals[title] = 0
  for (const [target, n] of Object.entries(counts)) {
    const canonical = redirects[target]
    if (canonical && cohortSet.has(canonical)) totals[canonical] += n
  }
  return totals
}

// ----------------------------------------------------------------- stages

/** Full task-force listing with per-article importance. */
async function stageCohort() {
  const articles = []
  let cont = {}
  do {
    const data = await apiGet(EN_API, {
      action: 'query', list: 'projectpages', wppprojects: PROJECT,
      wppassessments: 'true', wpplimit: 'max', ...cont
    })
    for (const page of (data.query?.projects?.[PROJECT] || [])) {
      if (page.ns !== 0) continue
      const importance = (page.assessment?.importance || 'unknown').toLowerCase()
      articles.push({ title: page.title, importance: importance || 'unknown' })
    }
    cont = data.continue || null
    process.stdout.write(`\r  cohort: ${articles.length} articles`)
  } while (cont)
  console.log()
  return articles
}

/** title -> Wikidata Q-id (articles without an item are simply absent). */
async function stageQids(cohort) {
  const checkpoint = loadCache('qids-progress') || { nextBatch: 0, qids: {} }
  const qids = checkpoint.qids
  const allBatches = [...batches(cohort.map(a => a.title), 50)]
  let done = checkpoint.nextBatch * 50
  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    const batch = allBatches[b]
    const data = await apiGet(EN_API, {
      action: 'query', prop: 'pageprops', ppprop: 'wikibase_item',
      titles: batch.join('|')
    })
    const renames = {}
    for (const n of (data.query?.normalized || [])) renames[n.to] = n.from
    for (const page of Object.values(data.query?.pages || {})) {
      const qid = page.pageprops?.wikibase_item
      if (qid) qids[renames[page.title] || page.title] = qid
    }
    done += batch.length
    if (b % 25 === 24 || b === allBatches.length - 1) {
      saveCache('qids-progress', { nextBatch: b + 1, qids })
    }
    process.stdout.write(`\r  qids: ${done}/${cohort.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('qids-progress'), { force: true })
  return qids
}

/**
 * Cohort-internal inlink counts: crawl outgoing links of every cohort
 * article, count only links that land on another cohort member. Resumable -
 * progress is checkpointed every 10 batches.
 */
async function stageLinks(cohort) {
  const cohortSet = new Set(cohort.map(a => a.title))
  const titleList = cohort.map(a => a.title)
  const checkpoint = loadCache('links-progress') || { nextBatch: 0, counts: {} }
  const counts = checkpoint.counts
  const allBatches = [...batches(titleList, 50)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    let cont = {}
    do {
      const data = await apiGet(EN_API, {
        action: 'query', prop: 'links', plnamespace: 0, pllimit: 'max',
        titles: allBatches[b].join('|'), ...cont
      })
      for (const page of Object.values(data.query?.pages || {})) {
        for (const link of (page.links || [])) {
          if (cohortSet.has(link.title)) {
            counts[link.title] = (counts[link.title] || 0) + 1
          }
        }
      }
      cont = data.continue || null
      await sleep(50)
    } while (cont)
    if (b % 10 === 9 || b === allBatches.length - 1) {
      saveCache('links-progress', { nextBatch: b + 1, counts })
    }
    process.stdout.write(`\r  links: batch ${b + 1}/${allBatches.length}`)
  }
  console.log()
  fs.rmSync(cachePath('links-progress'), { force: true })
  return counts
}

/**
 * The same cohort-internal inlink count, but counting only links written in
 * an article's own wikitext - navbox and other transcluded links excluded.
 * Answers Pi.1415926535's objection on the task force talk page (2026-07-22)
 * that navbox links dominate the inlink metric for lesser-known articles.
 *
 * Like stageLinks this does not resolve redirects, so a prose link written
 * through a redirect misses the cohort on both measures alike - the two
 * columns stay comparable. Resumable via checkpoint.
 */
async function stageLinksProse(cohort) {
  const cohortSet = new Set(cohort.map(a => a.title))
  const checkpoint = loadCache('links-prose-progress') || { nextBatch: 0, counts: {} }
  const counts = checkpoint.counts
  // 20 per batch, not 50: these responses carry full article wikitext.
  const allBatches = [...batches(cohort.map(a => a.title), 20)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    let cont = {}
    do {
      const data = await apiGet(EN_API, {
        action: 'query', prop: 'revisions', rvslots: 'main', rvprop: 'content',
        titles: allBatches[b].join('|'), ...cont
      })
      for (const page of Object.values(data.query?.pages || {})) {
        const text = page.revisions?.[0]?.slots?.main?.['*']
        for (const target of wikitextLinks(text)) {
          if (cohortSet.has(target)) counts[target] = (counts[target] || 0) + 1
        }
      }
      cont = data.continue || null
      await sleep(50)
    } while (cont)
    if (b % 25 === 24 || b === allBatches.length - 1) {
      saveCache('links-prose-progress', { nextBatch: b + 1, counts })
    }
    process.stdout.write(`\r  links-prose: batch ${b + 1}/${allBatches.length}`)
  }
  console.log()
  fs.rmSync(cachePath('links-prose-progress'), { force: true })
  return counts
}

/**
 * Every mainspace target the cohort links to in prose, unfiltered.
 *
 * stageLinksProse keeps only cohort-internal hits, which is the same mistake
 * prop=links made at a different level: the moment you need counts for some
 * OTHER set (untagged tagging candidates, a future region), the provenance is
 * gone and the crawl has to be repeated. This stage stores the full outgoing
 * count so any target set can be scored from cache. Resumable via checkpoint.
 */
async function stageLinksProseAll(universe) {
  const checkpoint = loadCache('links-prose-all-progress') || { nextBatch: 0, counts: {} }
  const counts = checkpoint.counts
  const allBatches = [...batches(universe.map(a => a.title), 20)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    let cont = {}
    do {
      const data = await apiGet(EN_API, {
        action: 'query', prop: 'revisions', rvslots: 'main', rvprop: 'content',
        titles: allBatches[b].join('|'), ...cont
      })
      for (const page of Object.values(data.query?.pages || {})) {
        const text = page.revisions?.[0]?.slots?.main?.['*']
        for (const target of wikitextLinks(text)) {
          counts[target] = (counts[target] || 0) + 1
        }
      }
      cont = data.continue || null
      await sleep(50)
    } while (cont)
    if (b % 25 === 24 || b === allBatches.length - 1) {
      saveCache('links-prose-all-progress', { nextBatch: b + 1, counts })
    }
    process.stdout.write(`\r  links-prose-all: batch ${b + 1}/${allBatches.length}`)
  }
  console.log()
  fs.rmSync(cachePath('links-prose-all-progress'), { force: true })
  return counts
}

// Wikidata properties that say the SUBJECT IS in the Bay Area, as opposed to
// merely having passed through it. Reagan worked at Fort Mason and Microsoft has
// a Silicon Valley campus - both true, neither a Bay Area topic. Born/died/worked
// (P19/P20/P937) account for ~10,900 of ~15,500 raw candidates and almost none
// are plausible additions; this also matches the 2007 criteria, which put
// "biographies of people originally from the SFBA that are not well connected to
// it" at Low.
const IS_HERE_PROPERTIES = ['P131', 'P159', 'P276', 'P39']

/**
 * The set of articles eligible for ranking: everything already tagged (minus
 * NA-class non-articles), plus Wikidata candidates that are actually in the
 * region. Both the SOURCES and the TARGETS of the link count are drawn from this
 * set - if only tagged articles count as sources, then under-tagged parts of the
 * region generate fewer links and stay under-tagged, which is self-reinforcing.
 */
function buildUniverse(cohort, candidates) {
  const universe = cohort
    .filter(a => a.importance !== 'na')
    .map(a => ({ title: a.title, importance: a.importance, tagged: true }))
  const seen = new Set(universe.map(u => u.title))
  for (const c of (candidates || [])) {
    if (seen.has(c.title)) continue
    if (!c.via.some(v => IS_HERE_PROPERTIES.includes(v))) continue
    seen.add(c.title)
    universe.push({ title: c.title, importance: null, tagged: false })
  }
  return universe
}

/**
 * Cut a descending-ranked list into importance tiers at percentile boundaries.
 * Percentiles rather than link thresholds because the thresholds shift as the
 * encyclopedia grows, and because tier SIZE is the thing the project actually has
 * an opinion about. Where the cuts fall is a judgement call the data cannot make.
 * Returns the rows (mutated with `tier`) plus the inlink cutoff for each tier.
 */
function assignTiers(ranked, { top, high, mid }) {
  const n = ranked.length
  const nTop = Math.round(top * n)
  const nHigh = Math.round(high * n)
  const nMid = Math.round(mid * n)
  ranked.forEach((row, i) => {
    row.tier = i < nTop ? 'top' : i < nHigh ? 'high' : i < nMid ? 'mid' : 'low'
  })
  ranked.cutoffs = {
    top: nTop ? ranked[nTop - 1].inlinks : null,
    high: nHigh ? ranked[nHigh - 1].inlinks : null,
    mid: nMid ? ranked[nMid - 1].inlinks : null
  }
  return ranked
}

/**
 * Titles needing a redirect map: the cohort, plus any untagged tagging
 * candidates. Candidates are included because the full-pool ranking scores them
 * alongside cohort articles, and without their redirects they are undercounted
 * exactly as the cohort was.
 */
function redirectTargets(cohort, candidates) {
  const titles = cohort.map(a => a.title)
  for (const c of (candidates || [])) titles.push(c.title)
  return [...new Set(titles)]
}

/**
 * redirect title -> canonical title. Feeds canonicalInlinks(); see that function
 * for why this matters. Every article also maps to itself, so the map alone is
 * enough to resolve any target. Resumable via checkpoint.
 */
async function stageRedirects(titles) {
  const checkpoint = loadCache('redirects-progress') || { nextBatch: 0, map: {} }
  const map = checkpoint.map
  const allBatches = [...batches(titles, 50)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    let cont = {}
    do {
      const data = await apiGet(EN_API, {
        action: 'query', prop: 'redirects', rdnamespace: 0, rdlimit: 'max',
        titles: allBatches[b].join('|'), ...cont
      })
      for (const page of Object.values(data.query?.pages || {})) {
        if (page.missing !== undefined) continue
        map[page.title] = page.title
        for (const r of (page.redirects || [])) map[r.title] = page.title
      }
      cont = data.continue || null
      await sleep(50)
    } while (cont)
    if (b % 25 === 24 || b === allBatches.length - 1) {
      saveCache('redirects-progress', { nextBatch: b + 1, map })
    }
    process.stdout.write(`\r  redirects: batch ${b + 1}/${allBatches.length} (${Object.keys(map).length} titles)`)
  }
  console.log()
  fs.rmSync(cachePath('redirects-progress'), { force: true })
  return map
}

/**
 * Wikidata entanglement: for each item, count statements whose value is a
 * Bay Area place (from the bot's claim-watch target cache) or a Bay Area
 * office (P39). Resumable via checkpoint.
 */
async function stageClaims(qids) {
  const targets = loadTargets()
  const places = new Set(targets.places)
  const positions = new Set(targets.positions)
  const allQids = [...new Set(Object.values(qids))]
  const checkpoint = loadCache('claims-progress') || { nextBatch: 0, counts: {} }
  const counts = checkpoint.counts
  const allBatches = [...batches(allQids, 50)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    const data = await apiGet(WD_API, {
      action: 'wbgetentities', ids: allBatches[b].join('|'), props: 'claims'
    })
    for (const [qid, entity] of Object.entries(data.entities || {})) {
      let n = 0
      for (const [prop, claims] of Object.entries(entity.claims || {})) {
        for (const claim of claims) {
          const value = claim.mainsnak?.datavalue?.value
          const target = value && value['entity-type'] === 'item' ? `Q${value['numeric-id']}` : null
          if (!target) continue
          if (places.has(target) || (prop === 'P39' && positions.has(target))) n++
        }
      }
      counts[qid] = n
    }
    if (b % 10 === 9 || b === allBatches.length - 1) {
      saveCache('claims-progress', { nextBatch: b + 1, counts })
    }
    process.stdout.write(`\r  claims: batch ${b + 1}/${allBatches.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('claims-progress'), { force: true })
  return counts
}

function loadTargets() {
  const p = path.join(__dirname, '..', 'data', 'wikidata-claim-targets.json')
  if (!fs.existsSync(p)) {
    throw new Error(`${p} missing - run the bot once locally or copy the cache`)
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

/** All WikiProjects assessing each article (for the exclusivity metric). */
async function stageAssessments(cohort) {
  const checkpoint = loadCache('assessments-progress') || { nextBatch: 0, result: {} }
  const result = checkpoint.result
  const allBatches = [...batches(cohort.map(a => a.title), 50)]
  let done = checkpoint.nextBatch * 50
  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    const batch = allBatches[b]
    const data = await apiGet(EN_API, {
      action: 'query', prop: 'pageassessments', pasubprojects: 'true',
      palimit: 'max', titles: batch.join('|')
    })
    const renames = {}
    for (const n of (data.query?.normalized || [])) renames[n.to] = n.from
    for (const page of Object.values(data.query?.pages || {})) {
      const title = renames[page.title] || page.title
      const projects = Object.keys(page.pageassessments || {})
      const others = projects.filter(p => p !== PROJECT)
      result[title] = { otherProjects: others.length }
    }
    done += batch.length
    if (b % 25 === 24 || b === allBatches.length - 1) {
      saveCache('assessments-progress', { nextBatch: b + 1, result })
    }
    process.stdout.write(`\r  assessments: ${done}/${cohort.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('assessments-progress'), { force: true })
  return result
}

/** Lead-text positioning: how early does the lead mention the Bay Area? */
async function stageLeads(cohort) {
  const checkpoint = loadCache('leads-progress') || { nextBatch: 0, scores: {} }
  const scores = checkpoint.scores
  const allBatches = [...batches(cohort.map(a => a.title), 20)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    const data = await apiGet(EN_API, {
      action: 'query', prop: 'extracts', exintro: 1, explaintext: 1,
      exlimit: 'max', titles: allBatches[b].join('|')
    })
    const renames = {}
    for (const n of (data.query?.normalized || [])) renames[n.to] = n.from
    for (const page of Object.values(data.query?.pages || {})) {
      const title = renames[page.title] || page.title
      const { score, term } = leadScore(page.extract)
      scores[title] = term ? { score, term } : { score }
    }
    if (b % 25 === 24 || b === allBatches.length - 1) {
      saveCache('leads-progress', { nextBatch: b + 1, scores })
    }
    process.stdout.write(`\r  leads: batch ${b + 1}/${allBatches.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('leads-progress'), { force: true })
  return scores
}

/**
 * Total-inlink denominators for every Top/High article, so the demote
 * ranking can use the inlink RATIO (SF inlinks / all inlinks) rather than
 * the raw count. Raw counts let famous-but-incidental articles (Netscape)
 * hide behind their cluster's link volume. Resumable via checkpoint.
 */
async function stageDenoms(cohort) {
  const titles = cohort
    .filter(a => a.importance === 'top' || a.importance === 'high')
    .map(a => a.title)
  const checkpoint = loadCache('denoms-progress') || { next: 0, totals: {} }
  const totals = checkpoint.totals

  for (let i = checkpoint.next; i < titles.length; i++) {
    totals[titles[i]] = await fetchBacklinkCount(titles[i])
    if (i % 20 === 19 || i === titles.length - 1) {
      saveCache('denoms-progress', { next: i + 1, totals })
    }
    process.stdout.write(`\r  denoms: ${i + 1}/${titles.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('denoms-progress'), { force: true })
  return totals
}

// ---------------------------------------------------------------- scoring

/**
 * Pure scoring core, separated for tests. Returns per-article rows with
 * raw metrics, per-metric percentiles, and the median significance score.
 */
function scoreCohort({ cohort, qids, links, claims, assessments, leads, denoms = {}, linksProse = null, linksCanonical = null }) {
  const rows = cohort.map(({ title, importance }) => {
    const qid = qids[title] || null
    return {
      title,
      importance,
      qid,
      inlink: links[title] || 0,
      ...(linksProse ? { inlinkProse: linksProse[title] || 0 } : {}),
      ...(linksCanonical ? { inlinkCanonical: linksCanonical[title] || 0 } : {}),
      entangle: qid !== null && claims[qid] !== undefined ? claims[qid] : 0,
      exclusive: 1 / (1 + (assessments[title]?.otherProjects ?? 0)),
      lead: leads[title]?.score ?? 0,
      leadTerm: leads[title]?.term || null
    }
  })

  // `exclusive` (1/(1+other WikiProjects)) is deliberately NOT a metric: scored
  // against 11,778 human ratings it correlates -0.082, i.e. backwards. Important
  // topics attract MORE WikiProjects, not fewer. It stays on the row as evidence.
  const metrics = ['inlink', 'entangle', 'lead']
  for (const metric of metrics) {
    const ranks = percentileRanks(rows.map(r => r[metric]))
    rows.forEach((row, i) => { row[`${metric}Pct`] = ranks[i] })
  }
  for (const row of rows) {
    row.significance = median(metrics.map(m => row[`${m}Pct`]))
  }

  // Intermediate score: navbox links removed, redirects still unresolved.
  // Retained so the report can show what the navbox fix alone changed.
  if (linksProse) {
    const proseRanks = percentileRanks(rows.map(r => r.inlinkProse))
    rows.forEach((row, i) => { row.inlinkProsePct = proseRanks[i] })
    for (const row of rows) {
      row.significanceProse = median(
        [row.inlinkProsePct, row.entanglePct, row.leadPct])
    }
  }

  // The score. Canonical inlinks alone: measured against the human corpus it
  // reaches r=0.520, while the median-of-metrics composite reaches 0.282, and
  // entangle/lead add +0.0006 and +0.0000 on top of inlinks respectively. They
  // remain on the row as evidence for a human reading the report, and `lead`
  // still matters as a RELEVANCE gate when scoring articles outside the
  // already-Bay-Area-filtered cohort - see docs/importance-ranking-methodology.md.
  if (linksCanonical) {
    const ranks = percentileRanks(rows.map(r => r.inlinkCanonical))
    rows.forEach((row, i) => { row.significance = ranks[i] })
  }

  // Total-inlink denominators stay as reported evidence. The old ratio-based
  // refinement for Top/High (significanceTH) is gone: it was the single largest
  // source of bad demotes, penalising articles that are both locally central
  // and globally famous - which is what an important Bay Area topic looks like.
  for (const row of rows) {
    if (!denoms[row.title]) continue
    row.totalInlinks = denoms[row.title].count
    row.totalCapped = denoms[row.title].capped
    row.ratio = (row.inlinkCanonical ?? row.inlink) / Math.max(row.totalInlinks, 1)
  }
  return rows
}

/** Boundary churn: the only lists a human ever sees. */
function pickCandidates(rows, { perDirection = CANDIDATES_PER_DIRECTION } = {}) {
  const sortKey = r => r.significance
  const demote = rows
    .filter(r => r.importance === 'top' || r.importance === 'high')
    .sort((a, b) => sortKey(a) - sortKey(b))
    .slice(0, perDirection)
  const promote = rows
    .filter(r => ['mid', 'low', 'unknown'].includes(r.importance))
    .sort((a, b) => b.significance - a.significance)
    .slice(0, perDirection)
  return { demote, promote }
}

async function stageScore() {
  const inputs = {
    cohort: loadCache('cohort'),
    qids: loadCache('qids'),
    links: loadCache('links'),
    claims: loadCache('claims'),
    assessments: loadCache('assessments'),
    leads: loadCache('leads'),
    denoms: loadCache('denoms')
  }
  const missing = Object.entries(inputs).filter(([, v]) => !v).map(([k]) => k)
  if (missing.length) throw new Error(`missing stage caches: ${missing.join(', ')}`)
  // Optional: without it the report simply omits the navbox-free columns.
  const linksProse = loadCache('links-prose')
  if (!linksProse) console.log('  note: links-prose not cached, scoring raw only')

  // The real score. Needs the UNFILTERED prose crawl (links-prose-all) plus the
  // redirect map, because redirect titles are not cohort members and so were
  // discarded by the filtered links-prose stage.
  const proseAll = loadCache('links-prose-all')
  const redirects = loadCache('redirects')
  let linksCanonical = null
  if (proseAll && redirects) {
    linksCanonical = canonicalInlinks(proseAll, redirects, inputs.cohort.map(a => a.title))
    const after = Object.values(linksCanonical).reduce((a, b) => a + b, 0)
    const before = Object.values(linksProse || {}).reduce((a, b) => a + b, 0)
    console.log(`  canonical inlinks: ${after} edges (${before} before redirect resolution)`)
  } else {
    console.log('  note: links-prose-all and/or redirects not cached - ' +
      'falling back to the weaker median-of-metrics score')
  }
  const rows = scoreCohort({ ...inputs, linksProse, linksCanonical })
  console.log(`  scored ${rows.length} articles`)
  return rows
}

// ----------------------------------------------------------------- report

/** Total mainspace inlinks (the expensive denominator), capped at 10k. */
async function fetchBacklinkCount(title) {
  let count = 0
  let cont = {}
  for (let page = 0; page < 20; page++) {
    const data = await apiGet(EN_API, {
      action: 'query', list: 'backlinks', bltitle: title,
      blnamespace: 0, bllimit: 'max', ...cont
    })
    count += (data.query?.backlinks || []).length
    cont = data.continue
    if (!cont) return { count, capped: false }
    await sleep(50)
  }
  return { count, capped: true }
}

/** 12 months of human pageviews ending with the last complete month. */
async function fetchPageviews(title, { now = new Date() } = {}) {
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1)
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth() + 1, 1))
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '')
  const encoded = encodeURIComponent(title.replace(/ /g, '_'))
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/` +
    `en.wikipedia/all-access/user/${encoded}/monthly/${fmt(start)}00/${fmt(end)}00`
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA } })
    if (!res.ok) return null
    const data = await res.json()
    return (data.items || []).reduce((sum, item) => sum + item.views, 0)
  } catch { return null }
}

function reportTable(rows) {
  const canon = rows.some(r => r.inlinkCanonical !== undefined)
  const header =
    '| Article | Current | Signif. | SF inlinks (canonical) | raw | Total inlinks' +
    ' | Entangle | Other projects | Lead | Views/yr |\n' +
    '|---|---|---|---|---|---|---|---|---|---|\n'
  const lines = rows.map(r => {
    const total = r.totalInlinks == null ? '?' : `${r.totalInlinks}${r.totalCapped ? '+' : ''}`
    const scored = canon ? r.inlinkCanonical : r.inlink
    const share = r.totalInlinks ? ` (${Math.round(100 * scored / r.totalInlinks)}%)` : ''
    const otherProjects = Math.round(1 / r.exclusive - 1)
    const lead = r.leadTerm ? `${r.lead.toFixed(2)} "${r.leadTerm}"` : '-'
    const views = r.views == null ? '?' : r.views.toLocaleString('en-US')
    return `| [${r.title.replace(/\|/g, '\\|')}](https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))})` +
      ` | ${r.importance} | ${(100 * r.significance).toFixed(1)}` +
      ` | ${scored}${share} | ${r.inlink} | ${total}` +
      ` | ${r.entangle} | ${otherProjects} | ${lead} | ${views} |`
  })
  return header + lines.join('\n') + '\n'
}

async function stageReport() {
  const rows = loadCache('scores')
  if (!rows) throw new Error('run the score stage first')
  const { demote, promote } = pickCandidates(rows)
  const candidates = [...demote, ...promote]

  console.log(`  enriching ${candidates.length} candidates (denominators + pageviews)`)
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i]
    const [backlinks, views] = await Promise.all([
      c.totalInlinks == null ? fetchBacklinkCount(c.title) : null,
      fetchPageviews(c.title)
    ])
    if (backlinks) {
      c.totalInlinks = backlinks.count
      c.totalCapped = backlinks.capped
    }
    c.views = views
    process.stdout.write(`\r  enriched ${i + 1}/${candidates.length}`)
  }
  console.log()

  const tierCounts = {}
  for (const r of rows) tierCounts[r.importance] = (tierCounts[r.importance] || 0) + 1

  const canon = rows.some(r => r.inlinkCanonical !== undefined)
  const method = canon ? `
Significance = percentile rank of **canonical inlinks**: how many other task-force
articles link to this one, counting only links written in an article's own wikitext
(navbox and other transcluded links excluded) and folding redirects onto the
canonical title. Both corrections matter - 77% of raw link edges are
template-generated, and a further 14% were being lost to unresolved redirects,
disproportionately for the most important articles.

The "raw" column is the original count for comparison. Wikidata entanglement,
other-project count, lead position and pageviews are shown as evidence for a human
reader but do NOT enter the score: measured against 11,758 existing human ratings
they add at most +0.006 to the score's predictive power, and other-project count is
actively backwards. See docs/importance-ranking-methodology.md.
` : `
NOTE: scored with the legacy median-of-metrics composite, which is measurably
weaker (r=0.282 vs 0.520). Run the \`links-prose-all\` and \`redirects\` stages to
enable canonical-inlink scoring.
`

  const md = `# SFBA task force importance reassessment

Generated by \`scripts/reassess.js\`. Cohort: ${rows.length} mainspace articles
(${Object.entries(tierCounts).map(([k, v]) => `${k} ${v}`).join(', ')}).
${method}
Only boundary churn is listed - this is not a review queue.

## Demote candidates (currently Top/High, weakest SF-significance)

${reportTable(demote)}
## Promote candidates (currently Mid/Low/unrated, strongest SF-significance)

${reportTable(promote)}
`
  fs.writeFileSync(path.join(DATA_DIR, 'report.md'), md)
  console.log(`  wrote ${path.join(DATA_DIR, 'report.md')}`)
  return { demote, promote }
}

// ----------------------------------------------------------------- runner

const STAGES = {
  cohort: () => stageCohort(),
  qids: () => stageQids(requireCache('cohort')),
  links: () => stageLinks(requireCache('cohort')),
  'links-prose': () => stageLinksProse(requireCache('cohort')),
  'links-prose-all': () => stageLinksProseAll(
    buildUniverse(requireCache('cohort'), loadCache('untagged-candidates'))),
  redirects: () => stageRedirects(redirectTargets(requireCache('cohort'), loadCache('untagged-candidates'))),
  claims: () => stageClaims(requireCache('qids')),
  assessments: () => stageAssessments(requireCache('cohort')),
  leads: () => stageLeads(requireCache('cohort')),
  denoms: () => stageDenoms(requireCache('cohort')),
  score: () => stageScore(),
  report: () => stageReport()
}

function requireCache(stage) {
  const data = loadCache(stage)
  if (!data) throw new Error(`stage "${stage}" has not run yet`)
  return data
}

async function main() {
  const arg = process.argv[2]
  if (!arg || (!STAGES[arg] && arg !== 'all')) {
    console.error(`usage: node scripts/reassess.js <${Object.keys(STAGES).join('|')}|all>`)
    process.exit(1)
  }
  const toRun = arg === 'all' ? Object.keys(STAGES) : [arg]
  for (const stage of toRun) {
    // 'all' skips completed stages; report is cheap enough to always rebuild
    if (arg === 'all' && stage !== 'report' && loadCache(stage)) {
      console.log(`${stage}: cached, skipping`)
      continue
    }
    console.log(`${stage}:`)
    const started = Date.now()
    const result = await STAGES[stage]()
    if (stage !== 'report') saveCache(stage === 'score' ? 'scores' : stage, result)
    console.log(`${stage}: done in ${Math.round((Date.now() - started) / 1000)}s`)
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exit(1) })
}

module.exports = {
  percentileRanks, median, leadScore, scoreCohort, pickCandidates, wikitextLinks,
  canonicalInlinks, redirectTargets, buildUniverse, assignTiers, IS_HERE_PROPERTIES,
  fetchPageviews, BAY_AREA_RE, apiGet, batches, EN_API, WD_API, UA, PROJECT
}
