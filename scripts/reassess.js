#!/usr/bin/env node

/**
 * Algorithmic reassessment of SFBA task force importance ratings.
 * LOCAL tool - never deployed to Toolforge, never run by the bot.
 *
 * Design: importance = SF-significance (is the Bay Area connection defining
 * or incidental?) gated first, prominence (pageviews) second. Four cheap
 * significance metrics are computed for the whole ~15k cohort, each is
 * converted to a percentile rank within the cohort, and the significance
 * score is the MEDIAN of the four percentiles - no weights to tune, and no
 * single metric can promote/demote an article alone.
 *
 * Metrics:
 *   inlink      - how many other task-force articles link here (graph
 *                 centrality within the SF cluster)
 *   entangle    - how many Wikidata statements connect the item to a Bay
 *                 Area place or office (structural depth)
 *   exclusive   - 1/(1+N other WikiProjects): is this article "ours" or
 *                 are we a courtesy tag on someone else's topic?
 *   lead        - how early the lead text mentions a Bay Area term
 *                 (defining connections appear in sentence one)
 *
 * Output is boundary churn only: top demote candidates (currently Top/High,
 * low significance) and top promote candidates (currently Mid/Low/unrated,
 * high significance). Expensive per-article data (total inlink denominators,
 * 12-month pageviews) is fetched only for those candidates.
 *
 * Usage: node scripts/reassess.js <stage>|all
 * Stages: cohort qids links claims assessments leads score report
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

async function apiGet(base, params, { tries = 4 } = {}) {
  const url = new URL(base)
  for (const [k, v] of Object.entries({ format: 'json', maxlag: 5, ...params })) {
    if (v !== undefined) url.searchParams.set(k, v)
  }
  // Replication lag is not a failure - the API is asking us to slow down.
  // Wait it out (up to ~10 min) without consuming retry attempts.
  let lagWaits = 0
  for (let attempt = 1; ; ) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      if (data.error) throw new Error(data.error.code === 'maxlag' ? 'maxlag' : `API error: ${data.error.code}`)
      return data
    } catch (error) {
      if (error.message === 'maxlag' && lagWaits < 60) {
        lagWaits++
        await sleep(10000)
        continue
      }
      if (attempt >= tries) throw error
      attempt++
      await sleep(2000 * attempt)
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
  const qids = {}
  let done = 0
  for (const batch of batches(cohort.map(a => a.title), 50)) {
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
    process.stdout.write(`\r  qids: ${done}/${cohort.length}`)
    await sleep(50)
  }
  console.log()
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
  const result = {}
  let done = 0
  for (const batch of batches(cohort.map(a => a.title), 50)) {
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
    process.stdout.write(`\r  assessments: ${done}/${cohort.length}`)
    await sleep(50)
  }
  console.log()
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
function scoreCohort({ cohort, qids, links, claims, assessments, leads, denoms = {} }) {
  const rows = cohort.map(({ title, importance }) => {
    const qid = qids[title] || null
    return {
      title,
      importance,
      qid,
      inlink: links[title] || 0,
      entangle: qid !== null && claims[qid] !== undefined ? claims[qid] : 0,
      exclusive: 1 / (1 + (assessments[title]?.otherProjects ?? 0)),
      lead: leads[title]?.score ?? 0,
      leadTerm: leads[title]?.term || null
    }
  })

  const metrics = ['inlink', 'entangle', 'exclusive', 'lead']
  for (const metric of metrics) {
    const ranks = percentileRanks(rows.map(r => r[metric]))
    rows.forEach((row, i) => { row[`${metric}Pct`] = ranks[i] })
  }
  for (const row of rows) {
    row.significance = median(metrics.map(m => row[`${m}Pct`]))
  }

  // Demote-side refinement: within Top/High, swap the raw inlink percentile
  // for the inlink-RATIO percentile (share of all inlinks coming from the
  // task force). Raw counts reward being famous inside a big cluster; the
  // ratio asks whether the task force is where this article's links live.
  const topHigh = rows.filter(r =>
    (r.importance === 'top' || r.importance === 'high') && denoms[r.title])
  if (topHigh.length) {
    for (const row of topHigh) {
      row.totalInlinks = denoms[row.title].count
      row.totalCapped = denoms[row.title].capped
      row.ratio = row.inlink / Math.max(row.totalInlinks, 1)
    }
    const ratioRanks = percentileRanks(topHigh.map(r => r.ratio))
    topHigh.forEach((row, i) => {
      row.ratioPct = ratioRanks[i]
      row.significanceTH = median([row.ratioPct, row.entanglePct, row.exclusivePct, row.leadPct])
    })
  }
  return rows
}

/** Boundary churn: the only lists a human ever sees. */
function pickCandidates(rows, { perDirection = CANDIDATES_PER_DIRECTION } = {}) {
  const sortKey = r => r.significanceTH ?? r.significance
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
  const rows = scoreCohort(inputs)
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
  const header = '| Article | Current | Signif. | SF inlinks | Total inlinks | Entangle | Other projects | Lead | Views/yr |\n' +
    '|---|---|---|---|---|---|---|---|---|\n'
  const lines = rows.map(r => {
    const total = r.totalInlinks == null ? '?' : `${r.totalInlinks}${r.totalCapped ? '+' : ''}`
    const ratio = r.totalInlinks ? ` (${Math.round(100 * r.inlink / r.totalInlinks)}%)` : ''
    const otherProjects = Math.round(1 / r.exclusive - 1)
    const lead = r.leadTerm ? `${r.lead.toFixed(2)} "${r.leadTerm}"` : '-'
    const views = r.views == null ? '?' : r.views.toLocaleString('en-US')
    return `| [${r.title.replace(/\|/g, '\\|')}](https://en.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))})` +
      ` | ${r.importance} | ${(100 * (r.significanceTH ?? r.significance)).toFixed(1)} | ${r.inlink}${ratio} | ${total}` +
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

  const md = `# SFBA task force importance reassessment

Generated by \`scripts/reassess.js\`. Cohort: ${rows.length} mainspace articles
(${Object.entries(tierCounts).map(([k, v]) => `${k} ${v}`).join(', ')}).

Significance = median of four percentile-ranked metrics: task-force-internal
inlinks, Wikidata Bay Area statement count, WikiProject exclusivity, and
lead-text mention position. Pageviews are shown as evidence but do not enter
the score. Only boundary churn is listed - this is not a review queue.

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
  percentileRanks, median, leadScore, scoreCohort, pickCandidates,
  fetchPageviews, BAY_AREA_RE, apiGet, batches, EN_API, WD_API, UA, PROJECT
}
