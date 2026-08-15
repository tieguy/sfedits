// Fetch wikitext for both sides of each edit in a cohort, cached one file
// per revid. Batched 10 revids/request, strictly serial, resumable.
// Usage: node scripts/analysis/edit-significance/fetch-pairs.js <cohort> [--host en.wikipedia.org]
const fs = require('fs')
const path = require('path')
const { actionSession } = require('../../../lib/mw-api')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')

async function main() {
  const args = process.argv.slice(2)
  const cohort = args[0]
  const hostIdx = args.indexOf('--host')
  const host = hostIdx > -1 ? args[hostIdx + 1] : 'en.wikipedia.org'
  if (!cohort) { console.error('usage: fetch-pairs.js <cohort> [--host <host>]'); process.exit(1) }

  const dir = path.join(DATA_ROOT, cohort)
  const cache = path.join(dir, 'pairs-cache')
  fs.mkdirSync(cache, { recursive: true })
  const edits = JSON.parse(fs.readFileSync(path.join(dir, 'edits.json')))

  const needed = new Set()
  for (const e of edits) { needed.add(e.revid); needed.add(e.parentid) }
  const toFetch = [...needed].filter(id => !fs.existsSync(path.join(cache, `${id}.txt`)))
  console.log(`${edits.length} edits, ${needed.size} revids, ${toFetch.length} to fetch`)

  const session = await actionSession(host, 'edit-significance-validation')
  let done = 0
  for (let i = 0; i < toFetch.length; i += 10) {
    const batch = toFetch.slice(i, i + 10)
    const resp = await session.request({
      action: 'query', prop: 'revisions', revids: batch.join('|'),
      rvslots: 'main', rvprop: 'ids|content', formatversion: 2
    })
    for (const page of resp.query?.pages || []) {
      for (const r of page.revisions || []) {
        fs.writeFileSync(path.join(cache, `${r.revid}.txt`), r.slots?.main?.content ?? '')
      }
    }
    // Revisions the API refused (revdeleted/suppressed): empty marker, not a refetch loop.
    for (const id of batch) {
      const f = path.join(cache, `${id}.txt`)
      if (!fs.existsSync(f)) fs.writeFileSync(f, '')
    }
    done += batch.length
    if (done % 200 < 10) console.log(`${done}/${toFetch.length}`)
  }
  console.log(`done: ${toFetch.length} fetched`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
