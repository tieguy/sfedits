// Sample recent mainspace human edits from a wiki via list=recentchanges,
// one slice per 23-hour step across a window. The 23-hour (not 24) stride
// is deliberate: successive slices precess one hour later in the day, so
// over 24+ slices the cohort covers every time of day AND every day of week
// (measurement hygiene: gnoming rates vary diurnally with bot/tool
// schedules and editor geography). Checkpoints edits.json per slice; resumable.
// Resume: stores absolute ISO timestamps of completed rcstart values in
// meta.doneSlices, so the window is preserved across invocations.
// Usage: node scripts/analysis/edit-significance/harvest-recentchanges.js <host> <cohort> <count> [--days 30]
//   e.g. node .../harvest-recentchanges.js en.wikipedia.org enwiki-random 1500
// recentchanges rows carry both revid and old_revid, so no per-title history
// pass is needed. Mirrors the live metadata filter: bots and minor excluded.
// (recentchanges retains ~30 days; --days above that returns empty slices.)
const fs = require('fs')
const path = require('path')
const { actionSession } = require('../../../lib/mw-api')

const DATA_ROOT = path.join(__dirname, '../../../data/edit-significance-validation')

async function main() {
  const args = process.argv.slice(2)
  const [host, cohort, countArg] = args
  const target = Number(countArg)
  const daysIdx = args.indexOf('--days')
  const days = daysIdx > -1 ? Number(args[daysIdx + 1]) : 30
  if (!host || !cohort || !Number.isFinite(target) || !Number.isFinite(days) || days < 1) {
    console.error('usage: harvest-recentchanges.js <host> <cohort> <count> [--days 30]')
    process.exit(1)
  }
  const dir = path.join(DATA_ROOT, cohort)
  fs.mkdirSync(dir, { recursive: true })
  const outPath = path.join(dir, 'edits.json')

  // Resume: existing edits count toward the target; already-covered slices
  // (tracked in edits-meta.json as absolute ISO timestamps) are skipped.
  const metaPath = path.join(dir, 'edits-meta.json')
  const edits = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath)) : []
  const meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath)) : { startedAt: null, doneSlices: [] }
  const seen = new Set(edits.map(e => e.revid))
  const perDay = Math.ceil(target / days)

  const session = await actionSession(host, 'edit-significance-validation')
  // Establish the anchor timestamp. On first run, record the current time and
  // use it for all slices. On resume, reuse the recorded anchor so the window
  // is preserved across invocations.
  if (!meta.startedAt) {
    meta.startedAt = new Date().toISOString()
  }
  const startedAtTime = new Date(meta.startedAt).getTime()
  for (let day = 0; day < days && edits.length < target; day++) {
    // 23-hour stride: each slice starts an hour later in the day than the
    // last, so time-of-day precesses across the full clock over the window.
    const rcstart = new Date(startedAtTime - day * 23 * 3600 * 1000).toISOString()
    if (meta.doneSlices.includes(rcstart)) continue
    let got = 0
    let rccontinue
    let exhausted = false // slice ran out of rows before filling its quota
    while (got < perDay && edits.length < target) {
      const params = {
        action: 'query', list: 'recentchanges',
        rcstart,
        rcnamespace: 0, rctype: 'edit', rcshow: '!bot|!minor',
        rcprop: 'title|ids|timestamp|user|tags|comment',
        rclimit: 'max', formatversion: 2
      }
      if (rccontinue) params.rccontinue = rccontinue
      const resp = await session.request(params)
      for (const rc of resp.query?.recentchanges || []) {
        if (!rc.old_revid) continue // page creations have no pair
        if (seen.has(rc.revid)) continue
        seen.add(rc.revid)
        edits.push({
          title: rc.title, revid: rc.revid, parentid: rc.old_revid,
          ts: rc.timestamp, user: rc.user, tags: rc.tags || [], comment: rc.comment || ''
        })
        got++
        if (got >= perDay || edits.length >= target) break
      }
      rccontinue = resp.continue?.rccontinue
      if (!rccontinue) { exhausted = true; break }
    }
    // A slice cut short by the global target is NOT done: leaving it out of
    // doneSlices lets a re-run with a larger target fill it, preserving the
    // even time-of-day coverage the 23-hour stride exists for.
    if (got >= perDay || exhausted) meta.doneSlices.push(rcstart)
    fs.writeFileSync(outPath, JSON.stringify(edits))
    fs.writeFileSync(metaPath, JSON.stringify(meta))
    console.log(`day-offset ${day}: +${got}, total ${edits.length}/${target}`)
  }
  console.log(`done: ${edits.length} edits -> ${cohort}/edits.json (${meta.doneSlices.length} slices)`)
  process.exit(0)
}
main().catch(e => { console.error(e); process.exit(1) })
