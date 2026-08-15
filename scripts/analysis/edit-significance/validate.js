// Run classifyEdit over a cohort's cached pairs and compare with mwedittypes
// labels. The GATE is directional (design §Phase 2): of edits mwedittypes
// labels prose-touching (Word/Sentence/Paragraph/Character), >=95% must
// classify substantive. The reverse bucket (we say substantive, no prose
// key) is EXPECTED — infobox values, references, media, tables and headings live
// under non-prose mwedittypes keys — so it is characterized, not gated.
// Usage: node scripts/analysis/edit-significance/validate.js <cohort> [lang]
const fs = require('fs')
const path = require('path')
const { classifyEdit } = require('../../../lib/edit-significance')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')
const PROSE_KEYS = new Set(['Word', 'Sentence', 'Paragraph', 'Character'])
// mwedittypes keys that map directly onto our substantive non-prose
// channels — used to characterize (not gate) the we-say-substantive-only
// bucket. Template is deliberately NOT here: template churn is an ignored
// channel, so a substantive verdict on a Template-keyed edit is only
// expected when wtf rendered the template into prose/infobox values —
// those are counted separately so a real over-trigger class can't hide.
const MAPPED_KEYS = new Set(['Reference', 'Media', 'Heading'])

function main() {
  const cohort = process.argv[2]
  const lang = process.argv[3] || 'en'
  if (!cohort) { console.error('usage: validate.js <cohort> [lang]'); process.exit(1) }
  const dir = path.join(DATA_ROOT, cohort)
  const cache = path.join(dir, 'pairs-cache')
  const edits = JSON.parse(fs.readFileSync(path.join(dir, 'edits.json')))
  const labels = new Map()
  for (const line of fs.readFileSync(path.join(dir, 'labels.jsonl'), 'utf-8').trim().split('\n')) {
    const rec = JSON.parse(line)
    labels.set(rec.revid, rec)
  }

  const out = fs.createWriteStream(path.join(dir, 'verdicts.jsonl'))
  let n = 0
  let skipped = 0
  let proseLabeled = 0
  let proseCaught = 0
  let bothNot = 0
  const missedProse = []   // mwedittypes says prose, we say not substantive — the gated failure mode
  const extraSubstantive = [] // we say substantive, mwedittypes has no prose key — characterized only
  for (const e of edits) {
    const label = labels.get(e.revid)
    if (!label || label.error || !label.types) { skipped++; continue }
    let prev, curr
    try {
      prev = fs.readFileSync(path.join(cache, `${e.parentid}.txt`), 'utf-8')
      curr = fs.readFileSync(path.join(cache, `${e.revid}.txt`), 'utf-8')
    } catch { skipped++; continue }
    if (!prev || !curr) { skipped++; continue }
    const v = classifyEdit(prev, curr, { lang })
    out.write(JSON.stringify({ revid: e.revid, ...v }) + '\n')
    n++
    const prose = Object.keys(label.types).some(k => PROSE_KEYS.has(k))
    if (prose) {
      proseLabeled++
      if (v.substantive) proseCaught++
      else missedProse.push({ revid: e.revid, title: e.title, ignored: v.ignored, types: Object.keys(label.types) })
    } else if (v.substantive) {
      const keys = Object.keys(label.types)
      const mapped = keys.some(k => MAPPED_KEYS.has(k))
      const templateOnly = !mapped && keys.includes('Template')
      extraSubstantive.push({ revid: e.revid, title: e.title, reasons: v.reasons, mapped, templateOnly, types: keys })
    } else {
      bothNot++
    }
  }
  out.end()

  console.log(`cohort=${cohort} lang=${lang} compared=${n} skipped=${skipped}`)
  if (proseLabeled === 0) {
    console.log('GATE: FAIL — zero prose-labeled edits; cohort or labels are broken')
    process.exit(1)
  }
  const caughtPct = proseCaught / proseLabeled * 100
  console.log(`prose-labeled=${proseLabeled}  caught=${proseCaught} (${caughtPct.toFixed(1)}%)  missed=${missedProse.length}`)
  console.log(`both-not-substantive=${bothNot}`)
  const mappedCount = extraSubstantive.filter(d => d.mapped).length
  const templateOnlyCount = extraSubstantive.filter(d => d.templateOnly).length
  const unexplained = extraSubstantive.length - mappedCount - templateOnlyCount
  console.log(`we-say-substantive-only=${extraSubstantive.length} ` +
    `(${mappedCount} carry mwedittypes Reference/Media/Heading keys — expected by design; ` +
    `${templateOnlyCount} carry only Template keys — expected ONLY when wtf renders the template, review a sample; ` +
    `${unexplained} carry neither — review every one)`)
  console.log('\nsample missed-prose (GATED — every one is a potential classifier bug; up to 15):')
  for (const d of missedProse.slice(0, 15)) console.log(' ', JSON.stringify(d))
  console.log('\nsample we-say-substantive-only, Template-only labels (up to 10):')
  for (const d of extraSubstantive.filter(x => x.templateOnly).slice(0, 10)) console.log(' ', JSON.stringify(d))
  console.log('\nsample we-say-substantive-only with neither prose nor mapped nor Template keys (up to 15):')
  for (const d of extraSubstantive.filter(x => !x.mapped && !x.templateOnly).slice(0, 15)) console.log(' ', JSON.stringify(d))
  const pass = caughtPct >= 95
  console.log(`\nGATE (design, directional): caught/prose-labeled = ${proseCaught}/${proseLabeled} ` +
    `= ${caughtPct.toFixed(1)}% >= 95% -> ${pass ? 'PASS' : 'FAIL'}`)
  process.exit(pass ? 0 : 1)
}
main()
