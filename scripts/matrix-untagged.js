#!/usr/bin/env node

/**
 * Interactive triage matrix for untagged Bay Area article candidates.
 * LOCAL tool - run scripts/reassess.js and scripts/reassess-untagged.js
 * first (their caches are prerequisites).
 *
 * Pool: untagged candidates whose common-scale significance (metrics
 * percentile-ranked across tagged+untagged together) beats the median
 * MID-tier tagged article - the "hard to argue against tagging" band.
 *
 * Output: data/reassess/matrix-untagged.html - a self-contained SVG
 * scatterplot (no external dependencies): x = pageviews (log), y =
 * significance, color = best existing quality class from other
 * WikiProjects, hover for Wikidata description, click to open.
 *
 * Every fetch stage checkpoints continuously and distinguishes "no data
 * for this article" (recorded) from network failure (retried, then the
 * stage aborts and a rerun resumes from the checkpoint). The runner
 * retries failed stages for up to ~2 hours, so a temporary loss of
 * connectivity delays the run instead of killing it.
 *
 * Usage: node scripts/matrix-untagged.js <pool|views|descriptions|classes|html|all>
 */

const fs = require('fs')
const path = require('path')
const {
  percentileRanks, median, api, batches, EN_API, WD_API
} = require('./reassess')
const { wmFetch } = require('../lib/mw-api')

const DATA_DIR = path.join(__dirname, '..', 'data', 'reassess')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function cachePath(stage) { return path.join(DATA_DIR, `matrix-${stage}.json`) }
function loadCache(stage) {
  const p = cachePath(stage)
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null
}
function saveCache(stage, data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  fs.writeFileSync(cachePath(stage), JSON.stringify(data))
}
function requireFile(name) {
  const p = path.join(DATA_DIR, `${name}.json`)
  if (!fs.existsSync(p)) throw new Error(`missing ${p} - run the earlier scripts first`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

// ----------------------------------------------------------------- stages

/** Untagged candidates above the tagged Mid-tier median, common scale. */
function stagePool() {
  const tagged = requireFile('scores')
  const untagged = requireFile('untagged-scores')
  const all = [
    ...tagged.map(r => ({ ...r, set: 'tagged' })),
    ...untagged.map(r => ({ ...r, set: 'untagged' }))
  ]
  for (const m of ['inlink', 'entangle', 'exclusive', 'lead']) {
    const ranks = percentileRanks(all.map(r => r[m]))
    all.forEach((r, i) => { r[`${m}P`] = ranks[i] })
  }
  for (const r of all) {
    r.sig = median(['inlinkP', 'entangleP', 'exclusiveP', 'leadP'].map(k => r[k]))
  }
  const midSigs = all.filter(r => r.set === 'tagged' && r.importance === 'mid')
    .map(r => r.sig).sort((a, b) => a - b)
  const midMedian = midSigs[Math.floor(midSigs.length / 2)]

  const pool = all
    .filter(r => r.set === 'untagged' && r.sig > midMedian)
    .sort((a, b) => b.sig - a.sig)
    .map(r => ({
      title: r.title, qid: r.qid, via: r.via, sig: r.sig,
      inlink: r.inlink, entangle: r.entangle,
      otherProjects: Math.round(1 / r.exclusive - 1), leadTerm: r.leadTerm
    }))
  console.log(`  ${pool.length} candidates above the Mid-tier median (${(100 * midMedian).toFixed(1)})`)
  return { midMedian, pool }
}

/**
 * 12 months of pageviews per candidate. HTTP error statuses mean "no
 * data" and are recorded; thrown fetch errors mean the network is bad -
 * retried a few times, then the stage aborts (checkpoint intact).
 */
async function stageViews(poolData) {
  const { pool } = poolData
  const checkpoint = loadCache('views-progress') || { views: {} }
  const views = checkpoint.views

  const now = new Date()
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1)
  const start = new Date(Date.UTC(end.getUTCFullYear() - 1, end.getUTCMonth() + 1, 1))
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '')

  async function fetchViews(title) {
    const encoded = encodeURIComponent(title.replace(/ /g, '_'))
    const url = 'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/' +
      `en.wikipedia/all-access/user/${encoded}/monthly/${fmt(start)}00/${fmt(end)}00`
    // Preserve the split: non-ok response → null ("no data"), transport failure → throws
    const res = await wmFetch(url, {
      component: 'reassess', tries: 5, backoffMs: 5000, throwOnHttpError: false
    })
    if (!res.ok) return null // article genuinely has no pageview data
    const data = await res.json()
    return (data.items || []).reduce((sum, item) => sum + item.views, 0)
  }

  let done = 0
  for (const { title } of pool) {
    if (title in views) { done++; continue }
    views[title] = await fetchViews(title)
    if (++done % 15 === 0) {
      saveCache('views-progress', { views })
      process.stdout.write(`\r  views: ${done}/${pool.length}`)
    }
    await sleep(60)
  }
  console.log(`\r  views: ${done}/${pool.length}`)
  fs.rmSync(cachePath('views-progress'), { force: true })
  return views
}

/** English Wikidata descriptions for hover tooltips. */
async function stageDescriptions(poolData) {
  const qids = [...new Set(poolData.pool.map(c => c.qid))]
  const checkpoint = loadCache('descriptions-progress') || { nextBatch: 0, desc: {} }
  const desc = checkpoint.desc
  const allBatches = [...batches(qids, 50)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    const data = await api(WD_API, {
      action: 'wbgetentities', ids: allBatches[b].join('|'),
      props: 'descriptions', languages: 'en'
    })
    for (const [qid, entity] of Object.entries(data.entities || {})) {
      desc[qid] = entity.descriptions?.en?.value || null
    }
    if (b % 5 === 4 || b === allBatches.length - 1) {
      saveCache('descriptions-progress', { nextBatch: b + 1, desc })
    }
    process.stdout.write(`\r  descriptions: batch ${b + 1}/${allBatches.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('descriptions-progress'), { force: true })
  return desc
}

const CLASS_RANK = { fa: 8, fl: 8, a: 7, ga: 6, b: 5, c: 4, start: 3, stub: 2, list: 1 }

/** Best existing quality class across each candidate's other projects. */
async function stageClasses(poolData) {
  const titles = poolData.pool.map(c => c.title)
  const checkpoint = loadCache('classes-progress') || { nextBatch: 0, classes: {} }
  const classes = checkpoint.classes
  const allBatches = [...batches(titles, 50)]

  for (let b = checkpoint.nextBatch; b < allBatches.length; b++) {
    const data = await api(EN_API, {
      action: 'query', prop: 'pageassessments', pasubprojects: 'true',
      palimit: 'max', titles: allBatches[b].join('|')
    })
    const renames = {}
    for (const n of (data.query?.normalized || [])) renames[n.to] = n.from
    for (const page of Object.values(data.query?.pages || {})) {
      const title = renames[page.title] || page.title
      let best = null
      for (const a of Object.values(page.pageassessments || {})) {
        const cls = (a.class || '').toLowerCase()
        if (CLASS_RANK[cls] && (!best || CLASS_RANK[cls] > CLASS_RANK[best])) best = cls
      }
      classes[title] = best
    }
    if (b % 5 === 4 || b === allBatches.length - 1) {
      saveCache('classes-progress', { nextBatch: b + 1, classes })
    }
    process.stdout.write(`\r  classes: batch ${b + 1}/${allBatches.length}`)
    await sleep(50)
  }
  console.log()
  fs.rmSync(cachePath('classes-progress'), { force: true })
  return classes
}

// ------------------------------------------------------------------- html

function stageHtml() {
  const { midMedian, pool } = loadCache('pool') || {}
  const views = loadCache('views')
  const desc = loadCache('descriptions')
  const classes = loadCache('classes')
  if (!pool || !views || !desc || !classes) throw new Error('missing matrix stage caches')

  const points = pool.map(c => ({
    t: c.title,
    s: Math.round(1000 * c.sig) / 10,
    v: views[c.title] ?? 0,
    d: desc[c.qid] || '',
    q: classes[c.title] || 'none',
    via: c.via.join(' '),
    il: c.inlink,
    en: c.entangle,
    op: c.otherProjects
  }))

  // Stamp the page with when the DATA was fetched, not when html was rebuilt.
  // This signals that the analysis is point-in-time, not live.
  const snapshot = fs.statSync(cachePath('views')).mtime.toISOString().slice(0, 10)
  const html = buildHtml(points, { midMedian, snapshot })
  const out = path.join(DATA_DIR, 'matrix-untagged.html')
  fs.writeFileSync(out, html)
  console.log(`  wrote ${out} (${points.length} points)`)
  return null
}

function buildHtml(points, { midMedian, snapshot }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SFBA untagged-article triage matrix</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 1rem 2rem; color: #1a1a1a; }
  h1 { font-size: 1.3rem; margin: 0 0 .2rem; }
  .sub { color: #555; font-size: .85rem; margin-bottom: .8rem; }
  .controls { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center;
    font-size: .85rem; margin-bottom: .5rem; }
  .controls label { display: inline-flex; align-items: center; gap: .25rem; }
  #search { padding: .25rem .5rem; width: 14rem; }
  #chart-wrap { position: relative; }
  svg { width: 100%; height: auto; background: #fafafa; border: 1px solid #ddd; }
  circle { cursor: pointer; stroke: rgba(0,0,0,.25); stroke-width: .5; }
  circle.dim { opacity: .08; pointer-events: none; }
  .guide { stroke: #bbb; stroke-dasharray: 4 3; }
  .quad { fill: #999; font-size: 11px; }
  .axis text { fill: #555; font-size: 10px; }
  .axis line { stroke: #ddd; }
  #tip { position: absolute; display: none; background: #fff; border: 1px solid #999;
    border-radius: 4px; padding: .5rem .6rem; font-size: .8rem; max-width: 22rem;
    pointer-events: none; box-shadow: 0 2px 8px rgba(0,0,0,.15); z-index: 2; }
  #tip b { font-size: .85rem; }
  #count { color: #555; }
  .legend { display: flex; gap: .8rem; flex-wrap: wrap; font-size: .8rem; margin: .4rem 0; }
  .legend span::before { content: '●'; margin-right: .25rem; }
  .quads { display: grid; grid-template-columns: 1fr 1fr; gap: .6rem 1.2rem;
    margin: 1rem 0; font-size: .85rem; max-width: 60rem; }
  .quads div { border-left: 3px solid #ccc; padding: .2rem .8rem; }
  .quads b { display: block; margin-bottom: .15rem; }
  .quads .ex { color: #555; }
</style>
</head>
<body>
<h1>SFBA untagged-article triage matrix</h1>
<div class="sub"><b>Data snapshot: ${snapshot}</b> - a point-in-time analysis, not a live view; articles
  leave this page as they get tagged. ${points.length} enwiki articles structurally connected to the Bay Area on
  Wikidata, untagged by the task force, all scoring above the tagged Mid-tier median
  significance (${(100 * midMedian).toFixed(1)}). x = pageviews/year (log), y = SF-significance.
  Color = best quality class from other WikiProjects. Hover for details, click to open.</div>
<div class="controls">
  <input id="search" type="search" placeholder="filter by title...">
  <label>min significance <input id="minsig" type="range" min="65" max="100" value="65">
    <span id="minsigv">65</span></label>
  <label>min views/yr <input id="minviews" type="range" min="0" max="70" value="0">
    <span id="minviewsv">0</span></label>
  <span id="vias"></span>
  <span id="count"></span>
</div>
<div class="legend" id="legend"></div>
<div id="chart-wrap">
  <svg id="chart" viewBox="0 0 960 560"></svg>
  <div id="tip"></div>
</div>
<div class="quads">
  <div><b>↖ Quiet infrastructure (high significance, low readership)</b>
    Deeply Bay-Area-central but rarely read - civic bodies, historical
    neighborhoods, local landmarks. Tagging is uncontroversial; most enter at
    Low or Mid importance.
    <span class="ex">Examples: Sausalito Ferry Terminal (96.2 significance,
    1.8k views/yr) · Heinlenville, San Jose's former Chinatown (95.8, 1.2k).</span></div>
  <div><b>↗ Tag first (high significance, high readership)</b>
    Strongly connected and widely read - the clearest omissions from the
    task force, worth tagging and rating individually.
    <span class="ex">Examples: U.S. Court of Appeals for the Ninth Circuit
    (84.7 significance, 196k views/yr) · Hoover Institution (86.5, 176k).</span></div>
  <div><b>↙ Lower priority (low significance, low readership)</b>
    Real but thin Bay Area connections on quiet articles. Fine to tag in
    bulk sweeps later, or skip.
    <span class="ex">Examples: Ray Kremer, 1920s Oakland-born pitcher
    (65.5, 1.3k) · Afara Websystems, acquired Sunnyvale startup (65.5, 1.5k).</span></div>
  <div><b>↘ Scrutinize: popular but peripheral? (low significance, high readership)</b>
    Famous topics whose Bay Area connection is real but narrow - a human
    should judge whether the tag helps the project before adding it.
    <span class="ex">Examples: Warren G. Harding, who died at SF's Palace
    Hotel (65.6 significance, 1.4M views/yr) · Jensen Huang, Nvidia CEO
    (68.9, 3.0M).</span></div>
</div>
<div class="sub">Part of <a href="/">San Francisco Edit Stream</a> · methodology
  described on the SFBA task force talk page</div>
<script>
const DATA = ${JSON.stringify(points)};
const QCOLOR = { fa: '#7b3fa0', fl: '#7b3fa0', a: '#2456a5', ga: '#2e7d32', b: '#4d94c9',
  c: '#e0a800', start: '#e07b39', stub: '#c0392b', list: '#888', none: '#b5b5b5' }
const QLABEL = { fa: 'FA/FL', a: 'A', ga: 'GA', b: 'B', c: 'C', start: 'Start',
  stub: 'Stub', list: 'List', none: 'unassessed' }

const W = 960, H = 560, M = { l: 50, r: 20, t: 20, b: 40 }
const maxV = Math.max(...DATA.map(p => p.v), 10)
const minS = Math.min(...DATA.map(p => p.s))
const maxS = Math.max(...DATA.map(p => p.s))
const x = v => M.l + (Math.log10(v + 1) / Math.log10(maxV + 1)) * (W - M.l - M.r)
const y = s => H - M.b - ((s - minS) / (maxS - minS || 1)) * (H - M.t - M.b)

const svg = document.getElementById('chart')
const NS = 'http://www.w3.org/2000/svg'
function el(name, attrs, parent) {
  const e = document.createElementNS(NS, name)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  ;(parent || svg).appendChild(e)
  return e
}

// axes
const ax = el('g', { class: 'axis' })
for (let e = 0; Math.pow(10, e) <= maxV * 10; e++) {
  const v = Math.pow(10, e)
  if (v > maxV * 3) break
  el('line', { x1: x(v), x2: x(v), y1: M.t, y2: H - M.b }, ax)
  const t = el('text', { x: x(v), y: H - M.b + 14, 'text-anchor': 'middle' }, ax)
  t.textContent = v.toLocaleString('en-US')
}
for (let s = Math.ceil(minS / 5) * 5; s <= maxS; s += 5) {
  el('line', { x1: M.l, x2: W - M.r, y1: y(s), y2: y(s) }, ax)
  const t = el('text', { x: M.l - 6, y: y(s) + 3, 'text-anchor': 'end' }, ax)
  t.textContent = s
}
const xl = el('text', { x: (W) / 2, y: H - 6, 'text-anchor': 'middle', class: 'quad' }, ax)
xl.textContent = 'pageviews / year (log scale)'
const yl = el('text', { x: 12, y: H / 2, 'text-anchor': 'middle',
  transform: 'rotate(-90 12 ' + (H / 2) + ')', class: 'quad' }, ax)
yl.textContent = 'SF-significance (common-scale percentile)'

// quadrant guides at pool medians
const med = a => { const s = [...a].sort((p, q) => p - q); return s[Math.floor(s.length / 2)] }
const mv = med(DATA.map(p => p.v)), ms = med(DATA.map(p => p.s))
el('line', { x1: x(mv), x2: x(mv), y1: M.t, y2: H - M.b, class: 'guide' })
el('line', { x1: M.l, x2: W - M.r, y1: y(ms), y2: y(ms), class: 'guide' })
const quads = [
  ['tag first', W - M.r - 5, M.t + 12, 'end'],
  ['quiet infrastructure - tag Low/Mid', M.l + 5, M.t + 12, 'start'],
  ['scrutinize: popular but peripheral?', W - M.r - 5, H - M.b - 6, 'end'],
  ['lower priority', M.l + 5, H - M.b - 6, 'start']
]
for (const [label, tx, ty, anchor] of quads) {
  const t = el('text', { x: tx, y: ty, 'text-anchor': anchor, class: 'quad' })
  t.textContent = label
}

// points
const tip = document.getElementById('tip')
const wrap = document.getElementById('chart-wrap')
const circles = DATA.map(p => {
  const c = el('circle', { cx: x(p.v), cy: y(p.s), r: 4, fill: QCOLOR[p.q] })
  c.addEventListener('mousemove', ev => {
    const r = wrap.getBoundingClientRect()
    tip.style.display = 'block'
    tip.style.left = Math.min(ev.clientX - r.left + 14, r.width - 360) + 'px'
    tip.style.top = (ev.clientY - r.top + 10) + 'px'
    tip.innerHTML = '<b>' + p.t + '</b>' + (p.d ? '<br>' + p.d : '') +
      '<br>significance ' + p.s + ' · ' + p.v.toLocaleString('en-US') + ' views/yr' +
      '<br>quality: ' + QLABEL[p.q] + ' · ' + p.op + ' other project' + (p.op === 1 ? '' : 's') +
      '<br>' + p.il + ' task-force inlinks · ' + p.en + ' BA statements · via ' + p.via
  })
  c.addEventListener('mouseleave', () => { tip.style.display = 'none' })
  c.addEventListener('click', () =>
    window.open('https://en.wikipedia.org/wiki/' + encodeURIComponent(p.t.replace(/ /g, '_')), '_blank'))
  return c
})

// legend (click to toggle quality classes)
const activeQ = new Set(Object.keys(QLABEL))
const legend = document.getElementById('legend')
for (const [q, label] of Object.entries(QLABEL)) {
  if (!DATA.some(p => p.q === q)) continue
  const s = document.createElement('span')
  s.style.color = QCOLOR[q]
  s.style.cursor = 'pointer'
  s.textContent = label + ' (' + DATA.filter(p => p.q === q).length + ')'
  s.onclick = () => {
    activeQ.has(q) ? activeQ.delete(q) : activeQ.add(q)
    s.style.textDecoration = activeQ.has(q) ? 'none' : 'line-through'
    render()
  }
  legend.appendChild(s)
}

// via filters
const allVias = [...new Set(DATA.flatMap(p => p.via.split(' ')))].sort()
const activeVia = new Set(allVias)
const viaBox = document.getElementById('vias')
for (const v of allVias) {
  const label = document.createElement('label')
  const cb = document.createElement('input')
  cb.type = 'checkbox'; cb.checked = true
  cb.onchange = () => { cb.checked ? activeVia.add(v) : activeVia.delete(v); render() }
  label.appendChild(cb); label.appendChild(document.createTextNode(v))
  viaBox.appendChild(label)
}

const search = document.getElementById('search')
const minsig = document.getElementById('minsig')
const minviews = document.getElementById('minviews')
// slider is log-scaled to match the axis: value 0-70 -> 10^(v/10), rounded
// to a clean threshold so the label reads 0, 100, 1,000, 25,000...
const viewsThreshold = () => {
  if (+minviews.value === 0) return 0
  const raw = Math.pow(10, +minviews.value / 10)
  const mag = Math.pow(10, Math.floor(Math.log10(raw)))
  return Math.round(raw / mag) * mag
}
search.oninput = render
minsig.oninput = () => { document.getElementById('minsigv').textContent = minsig.value; render() }
minviews.oninput = () => {
  document.getElementById('minviewsv').textContent = viewsThreshold().toLocaleString('en-US')
  render()
}

function render() {
  const term = search.value.toLowerCase()
  const minV = viewsThreshold()
  let shown = 0
  DATA.forEach((p, i) => {
    const ok = p.s >= +minsig.value &&
      p.v >= minV &&
      activeQ.has(p.q) &&
      p.via.split(' ').some(v => activeVia.has(v)) &&
      (!term || p.t.toLowerCase().includes(term))
    circles[i].classList.toggle('dim', !ok)
    if (ok) shown++
  })
  document.getElementById('count').textContent = shown + ' of ' + DATA.length + ' shown'
}
render()
</script>
</body>
</html>`
}

// ----------------------------------------------------------------- runner

const STAGES = {
  pool: () => stagePool(),
  views: () => stageViews(requireStage('pool')),
  descriptions: () => stageDescriptions(requireStage('pool')),
  classes: () => stageClasses(requireStage('pool')),
  html: () => stageHtml()
}

function requireStage(stage) {
  const data = loadCache(stage)
  if (!data) throw new Error(`stage "${stage}" has not run yet`)
  return data
}

async function main() {
  const arg = process.argv[2]
  if (!arg || (!STAGES[arg] && arg !== 'all')) {
    console.error(`usage: node scripts/matrix-untagged.js <${Object.keys(STAGES).join('|')}|all>`)
    process.exit(1)
  }
  const toRun = arg === 'all' ? Object.keys(STAGES) : [arg]
  for (const stage of toRun) {
    if (arg === 'all' && stage !== 'html' && loadCache(stage)) {
      console.log(`${stage}: cached, skipping`)
      continue
    }
    console.log(`${stage}:`)
    const started = Date.now()
    // Survive extended network outages: retry the stage for up to ~2h.
    // Checkpoints mean each retry resumes where the last attempt died.
    let result
    for (let attempt = 1; ; attempt++) {
      try {
        result = await STAGES[stage]()
        break
      } catch (error) {
        if (attempt >= 120) throw error
        console.log(`  ${stage} interrupted (${error.message}) - retrying in 60s [${attempt}]`)
        await sleep(60000)
      }
    }
    if (stage !== 'html') saveCache(stage, result)
    console.log(`${stage}: done in ${Math.round((Date.now() - started) / 1000)}s`)
  }
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exit(1) })
}

module.exports = { buildHtml, CLASS_RANK }
