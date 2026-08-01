#!/usr/bin/env node

/**
 * Produce the Bay Area article ranking, proposed importance tiers, and the bot
 * watchlist, from caches built by reassess.js and reassess-untagged.js.
 * LOCAL tool - never deployed, never run by the bot.
 *
 * The ranking is a single measure: how many other articles IN THE UNIVERSE link
 * to this one from their own prose, with navbox/template links excluded and
 * redirects folded onto canonical titles.
 *
 * The universe is every tagged article plus Wikidata candidates whose data says
 * the subject IS in the nine counties (located in / headquartered / at / holds a
 * Bay Area office), NOT merely that a person was born, died or worked here.
 * Sources and targets both come from that set - counting links only from tagged
 * articles would make under-tagged parts of the region look less central, which
 * is self-reinforcing.
 *
 * Tier CUTS are a judgement call the data cannot make. The defaults below are a
 * proposal, not a finding; --top/--high/--mid override them.
 *
 * Method and evidence: docs/importance-ranking-methodology.md
 *
 * Usage: node scripts/rank.js [--watchlist N] [--wide N]
 *                             [--top 0.0025] [--high 0.025] [--mid 0.15]
 * Outputs (data/reassess/):
 *   ranking.json          every article, ranked, with tier and current rating
 *   watchlist.json        the top N titles, bare array (legacy shape)
 *   watchlist-500.json    the bot's list, with provenance - published
 *   watchlist-2500.json   the wide list, with provenance - published, unwatched
 *   ranking-report.md     human-readable summary + the diffs
 */

const fs = require('fs')
const path = require('path')
const {
  canonicalInlinks, buildUniverse, assignTiers, IS_HERE_PROPERTIES
} = require('./reassess')

const DATA_DIR = path.join(__dirname, '..', 'data', 'reassess')
const DEFAULTS = { top: 0.0025, high: 0.025, mid: 0.15, watchlist: 500, wide: 2500 }

// The importance filter the DEPLOYED bot runs, which is the only honest
// baseline for the added/dropped diff below. Verified live against
// /api/topics.json on 2026-07-31: Top+High+Mid, 2,455 articles. This was
// ['top','high'] (506 articles) until then, which understated the size of the
// change by an order of magnitude - the switch drops ~2,000 articles, it does
// not swap ~290. If the live config's importance filter changes, change this.
const LIVE_IMPORTANCE = ['top', 'high', 'mid']

/**
 * The two published cuts of one ranking. The narrow list is what the bot
 * watches; the wide list is published for transparency and for anyone who
 * wants fuller coverage. Narrow is always a prefix of wide, so an article
 * never appears in the wide list but not the narrow one at a higher rank.
 */
function cuts(ranked, opts) {
  return {
    narrow: ranked.slice(0, opts.watchlist),
    wide: ranked.slice(0, opts.wide)
  }
}

function load(name) {
  const p = path.join(DATA_DIR, `${name}.json`)
  if (!fs.existsSync(p)) throw new Error(`missing ${p} - run the reassess stages first`)
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function parseArgs(argv) {
  const opts = { ...DEFAULTS }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '')
    if (!(key in DEFAULTS)) throw new Error(`unknown option ${argv[i]}`)
    opts[key] = Number(argv[i + 1])
    if (!Number.isFinite(opts[key])) throw new Error(`bad value for ${argv[i]}`)
  }
  return opts
}

const url = t => `https://en.wikipedia.org/wiki/${encodeURIComponent(t.replace(/ /g, '_'))}`
const link = t => `[${t.replace(/\|/g, '\\|')}](${url(t)})`

function table(rows, { showTier = true } = {}) {
  const head = `| Article | Links | Current | ${showTier ? 'Proposed |' : ''}\n` +
    `|---|---|---|${showTier ? '---|' : ''}\n`
  return head + rows.map(r =>
    `| ${link(r.title)} | ${r.inlinks} | ${r.tagged ? r.importance : '*untagged*'} |` +
    (showTier ? ` ${r.tier} |` : '')
  ).join('\n') + '\n'
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  const cohort = load('cohort')
  const candidates = load('untagged-candidates')
  const proseAll = load('links-prose-all')
  const redirects = load('redirects')

  const universe = buildUniverse(cohort, candidates)
  const counts = canonicalInlinks(proseAll, redirects, universe.map(u => u.title))
  universe.forEach(u => { u.inlinks = counts[u.title] || 0 })
  // ties broken by title so the output is stable between runs
  universe.sort((a, b) => b.inlinks - a.inlinks || a.title.localeCompare(b.title))
  const ranked = assignTiers(universe, opts)

  const RANK = { top: 3, high: 2, mid: 1, low: 0 }
  const rated = ranked.filter(r => RANK[r.importance] !== undefined)
  const unchanged = rated.filter(r => r.tier === r.importance).length
  const promoted = rated.filter(r => RANK[r.tier] > RANK[r.importance])
  const demoted = rated.filter(r => RANK[r.tier] < RANK[r.importance])
  const unrated = ranked.filter(r => r.importance === 'unknown')
  const newlyTagged = ranked.filter(r => !r.tagged)

  // the bot watchlist: purely the top N of the ranking
  const { narrow: watchlist, wide } = cuts(ranked, opts)
  const currentWatch = new Set(
    cohort.filter(a => LIVE_IMPORTANCE.includes(a.importance)).map(a => a.title))
  const watchNow = new Set(watchlist.map(r => r.title))
  const added = watchlist.filter(r => !currentWatch.has(r.title))
  const dropped = ranked.filter(r => currentWatch.has(r.title) && !watchNow.has(r.title))
    .sort((a, b) => b.inlinks - a.inlinks)

  // Published lists carry provenance: a bare array is hard to audit once it is
  // sitting on a webserver detached from the run that produced it.
  const publish = (titles) => JSON.stringify({
    generated_at: new Date().toISOString(),
    method: 'https://github.com/tieguy/sfedits/blob/integration/docs/importance-ranking-methodology.md',
    universe: ranked.length,
    count: titles.length,
    titles
  })

  fs.writeFileSync(path.join(DATA_DIR, 'ranking.json'), JSON.stringify(ranked))
  fs.writeFileSync(path.join(DATA_DIR, 'watchlist.json'),
    JSON.stringify(watchlist.map(r => r.title)))
  fs.writeFileSync(path.join(DATA_DIR, `watchlist-${opts.watchlist}.json`),
    publish(watchlist.map(r => r.title)))
  fs.writeFileSync(path.join(DATA_DIR, `watchlist-${opts.wide}.json`),
    publish(wide.map(r => r.title)))

  const pct = (a, b) => `${(100 * a / b).toFixed(0)}%`
  const md = `# Bay Area article ranking

Generated by \`scripts/rank.js\` on ${new Date().toISOString().slice(0, 10)}.
Method: [docs/importance-ranking-methodology.md](../../docs/importance-ranking-methodology.md)

Universe: **${ranked.length}** articles — ${ranked.filter(r => r.tagged).length} already
tagged, ${newlyTagged.length} Wikidata candidates whose data places them in the nine
counties via ${IS_HERE_PROPERTIES.join('/')}.

Ranked by prose links from other articles in the universe, navbox links excluded,
redirects folded.

## Proposed tiers

Cut points are a judgement call, not a finding. These are a proposal.

| Tier | Share | Articles | Link cutoff |
|---|---|---|---|
| Top | ${(100 * opts.top).toFixed(2)}% | ${ranked.filter(r => r.tier === 'top').length} | ${ranked.cutoffs.top} |
| High | ${(100 * opts.high).toFixed(1)}% | ${ranked.filter(r => r.tier === 'high').length} | ${ranked.cutoffs.high} |
| Mid | ${(100 * opts.mid).toFixed(0)}% | ${ranked.filter(r => r.tier === 'mid').length} | ${ranked.cutoffs.mid} |
| Low | rest | ${ranked.filter(r => r.tier === 'low').length} | |

## Effect on existing ratings

Of ${rated.length} currently-rated articles:

- unchanged: **${unchanged}** (${pct(unchanged, rated.length)})
- promoted: ${promoted.length}
- demoted: ${demoted.length}

${unrated.length} articles currently carry the banner with no rating and would get one.
${newlyTagged.length} articles are not tagged at all; of those,
${newlyTagged.filter(r => r.tier !== 'low').length} are proposed above Low and
warrant human review before being applied.

## Newly tagged, proposed above Low

${table(newlyTagged.filter(r => r.tier !== 'low'))}
## Top ${opts.watchlist} — the bot watchlist

Currently the bot watches **${currentWatch.size}** articles: everything rated
${LIVE_IMPORTANCE.map(i => i[0].toUpperCase() + i.slice(1)).join(', ')}.
Switching to the top ${opts.watchlist} of this ranking would **add ${added.length}**
and **drop ${dropped.length}** — a deliberate reduction in coverage, not a swap.

A wider cut of the same ranking is published alongside it as
\`watchlist-${opts.wide}.json\` (${wide.length} articles) for anyone who wants
fuller coverage than the bot posts.

### First 50 of the ranking

${table(ranked.slice(0, 50))}
### Added to the watchlist (${added.length})

${table(added)}
### Dropped from the watchlist (${dropped.length})

${table(dropped)}`

  fs.writeFileSync(path.join(DATA_DIR, 'ranking-report.md'), md)

  console.log(`universe ${ranked.length} (${ranked.filter(r => r.tagged).length} tagged + ${newlyTagged.length} new)`)
  console.log(`tiers: top ${ranked.filter(r => r.tier === 'top').length} (>=${ranked.cutoffs.top} links)` +
    `  high ${ranked.filter(r => r.tier === 'high').length} (>=${ranked.cutoffs.high})` +
    `  mid ${ranked.filter(r => r.tier === 'mid').length} (>=${ranked.cutoffs.mid})` +
    `  low ${ranked.filter(r => r.tier === 'low').length}`)
  console.log(`existing ratings: ${unchanged} unchanged (${pct(unchanged, rated.length)}), ` +
    `${promoted.length} promoted, ${demoted.length} demoted`)
  console.log(`watchlist: +${added.length} / -${dropped.length} vs the current ${currentWatch.size}`)
  console.log(`wrote ranking.json, watchlist.json, ranking-report.md`)
}

if (require.main === module) {
  try { main() } catch (error) { console.error(error.message); process.exit(1) }
}

module.exports = { parseArgs, DEFAULTS, LIVE_IMPORTANCE, cuts }
