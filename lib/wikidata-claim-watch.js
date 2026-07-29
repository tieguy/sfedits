/**
 * Wikidata claim watch: notify when a Bay Area connection is added/removed
 *
 * Watches the Wikidata edits already flowing through the EventStreams
 * connection and posts a Discord notice when a statement linking an entity
 * to the Bay Area changes - e.g. a person gains place of birth (P19) =
 * San Francisco, or a company's headquarters (P159) moves away.
 *
 * Detection is comment-based: Wikibase autocomments carry the property and
 * item value of the touched claim (`[[Property:P19]]: [[Q62]]`), so
 * filtering the ~10 events/s Wikidata firehose costs one regex per event -
 * no API calls until a claim actually matches.
 *
 * Values are matched against two precomputed sets, refreshed periodically
 * like the dynamic watchlist and cached to disk for restart/outage fallback:
 *  - places: every item whose located-in chain (P131+) reaches one of the
 *    nine Bay Area counties (~12k items), so "born in Berkeley" counts,
 *    not just "born in San Francisco"
 *  - positions: offices whose jurisdiction (P1001) is in the Bay Area
 *    (mayor of SF, member of the Board of Supervisors, ...), matched for P39
 *
 * Config (per account):
 *   "wikidata_claims": {
 *     "properties": ["P19", "P20", "P131", "P159", "P276", "P937"],
 *     "refresh_hours": 24,
 *     "rate_cap": { "max": 5, "window_minutes": 10 }
 *   }
 *
 * Rate cap: bulk imports (QuickStatements) can touch many Bay Area items at
 * once; posts beyond the cap are suppressed and surfaced as a single
 * "+N more" summary when the window rolls over. Bot edits are NOT exempt -
 * mass changes to SF data are exactly what deserves a notice.
 */

const fs = require('fs')
const path = require('path')

const { sparqlSelect } = require('./sparql')
// RateCap now lives with the other delivery limits; still re-exported below
// because test/wikidata-claim-watch.test.js and callers import it from here.
const { RateCap } = require('./delivery-limits')

const USER_AGENT = 'sfedits-wikidata-claim-watch/1.0 (https://github.com/tieguy/sfedits)'
const WIKIDATA_API = 'https://www.wikidata.org/w/api.php'

// The nine San Francisco Bay Area counties (Q62 is city-and-county)
const BAY_AREA_COUNTIES = [
  'Q62',      // San Francisco
  'Q107146',  // Alameda
  'Q108058',  // Contra Costa
  'Q108117',  // Marin
  'Q108137',  // Napa
  'Q108101',  // San Mateo
  'Q110739',  // Santa Clara
  'Q108083',  // Solano
  'Q108067'   // Sonoma
]

const DEFAULT_PROPERTIES = ['P19', 'P20', 'P131', 'P159', 'P276', 'P937']
const DEFAULT_REFRESH_HOURS = 24
const DEFAULT_RATE_CAP = { max: 5, window_minutes: 10 }
const CACHE_FILE = 'wikidata-claim-targets.json'

// Wikibase autocomment prefix -> what happened to the claim.
// wbsetclaim-update-rank is deliberately absent: rank fiddling isn't a
// change in what the data says, just in which statement is preferred.
const ACTION_BY_PREFIX = [
  [/^\/\* wbsetclaim-create/, 'added'],
  [/^\/\* wbcreateclaim-create/, 'added'],
  [/^\/\* wbremoveclaims-remove/, 'removed'],
  [/^\/\* wbsetclaimvalue/, 'changed'],
  [/^\/\* wbsetclaim-update-rank/, null],
  [/^\/\* wbsetclaim-update/, 'changed']
]

/**
 * Parse a Wikidata edit comment into a claim change, or null when the edit
 * is not an item-valued claim change (rank updates, string values, bulk
 * entity edits, plain talk-page edits, ...).
 *
 * @param {string} comment - recentchange comment
 * @returns {{action: string, property: string, value: string}|null}
 */
function parseClaimEdit(comment) {
  if (!comment) return null

  let action
  for (const [re, a] of ACTION_BY_PREFIX) {
    if (re.test(comment)) { action = a; break }
  }
  if (!action) return null

  const m = comment.match(/\[\[Property:(P\d+)\]\]: \[\[(Q\d+)\]\]/)
  if (!m) return null

  return { action, property: m[1], value: m[2] }
}

/**
 * Match a parsed claim change against the target sets.
 *
 * @param {{property: string, value: string}} parsed
 * @param {{places: Set, positions: Set}} sets
 * @param {Object} claimsConfig - account.wikidata_claims
 * @returns {{kind: string}|null}
 */
function matchClaim(parsed, sets, claimsConfig) {
  const properties = claimsConfig.properties || DEFAULT_PROPERTIES
  if (properties.includes(parsed.property) && sets.places.has(parsed.value)) {
    return { kind: 'place' }
  }
  if (parsed.property === 'P39' && sets.positions.has(parsed.value)) {
    return { kind: 'position' }
  }
  return null
}

/**
 * Build the place and position target sets from live Wikidata, falling back
 * to the on-disk cache (and then to empty sets) when SPARQL is unreachable.
 * Never throws.
 *
 * Places are queried one county at a time: the per-county P131+ queries are
 * fast (~2k results each) where a single nine-county union risks timeouts.
 *
 * @param {Object} claimsConfig - account.wikidata_claims (currently unused
 *   beyond signature symmetry; counties are fixed)
 * @param {Object} opts
 * @param {string} opts.dataDir - Directory for the cache file
 * @returns {Promise<{places: Set, positions: Set}>}
 */
async function refreshTargetSets(claimsConfig, { dataDir }) {
  const cacheFile = path.join(dataDir, CACHE_FILE)

  try {
    const places = new Set(BAY_AREA_COUNTIES)
    for (const county of BAY_AREA_COUNTIES) {
      const qids = await sparqlSelect(
        `SELECT DISTINCT ?p WHERE { ?p wdt:P131+ wd:${county} }`)
      for (const q of qids) places.add(q)
    }

    // Positions are also queried per county: an unanchored
    // P1001/P131+ union across all nine counties times out on WDQS,
    // but anchoring the transitive path at one county keeps each
    // query fast (same trick as the places loop).
    const positions = new Set()
    for (const county of BAY_AREA_COUNTIES) {
      const qids = await sparqlSelect(
        `SELECT DISTINCT ?pos WHERE {
           { ?pos wdt:P1001 wd:${county} }
           UNION { ?j wdt:P131+ wd:${county} . ?pos wdt:P1001 ?j }
         }`)
      for (const q of qids) positions.add(q)
    }

    try {
      fs.writeFileSync(cacheFile, JSON.stringify({
        fetched_at: new Date().toISOString(),
        places: [...places],
        positions: [...positions]
      }))
    } catch (e) {
      console.error('Could not write claim-target cache:', e.message)
    }
    console.log(`✓ Wikidata claim targets: ${places.size} places, ${positions.size} positions`)
    return { places, positions }
  } catch (error) {
    console.error('Wikidata claim-target refresh failed:', error.message)
    try {
      const cached = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
      console.error(`  Loaded ${cached.places.length} places from cache`)
      return { places: new Set(cached.places), positions: new Set(cached.positions) }
    } catch {
      console.error('  No cache available - claim watch is inactive until next refresh')
      return { places: new Set(), positions: new Set() }
    }
  }
}

/**
 * Fetch English labels for the entity, value, and property in one call.
 * Falls back to raw ids on any failure - a notice with Q-ids beats no notice.
 */
async function fetchLabels(ids) {
  try {
    const params = new URLSearchParams({
      action: 'wbgetentities',
      ids: ids.join('|'),
      props: 'labels',
      languages: 'en',
      format: 'json',
      formatversion: '2'
    })
    const response = await fetch(`${WIKIDATA_API}?${params}`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(15000)
    })
    if (!response.ok) throw new Error(`wbgetentities returned ${response.status}`)
    const data = await response.json()
    const labels = {}
    for (const id of ids) {
      labels[id] = data.entities?.[id]?.labels?.en?.value || id
    }
    return labels
  } catch (error) {
    const labels = {}
    for (const id of ids) labels[id] = id
    return labels
  }
}

const EMBED_COLORS = { added: 0x2ecc71, removed: 0xe74c3c, changed: 0xf1c40f }

// Lead with the action so "was the Bay Area link added or removed?" is
// answerable at a glance - the embed colour alone is too subtle.
const ACTION_LABELS = {
  added: '➕ **Added**',
  removed: '➖ **Removed**',
  changed: '✏️ **Changed to**'
}

// Discord can't render SVG, so point at a Commons PNG thumbnail
const WIKIDATA_ICON =
  'https://upload.wikimedia.org/wikipedia/commons/thumb/f/ff/Wikidata-logo.svg/240px-Wikidata-logo.svg.png'

async function postToWebhook(webhookUrl, payload) {
  const response = await fetch(`${webhookUrl}?wait=true`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) {
    throw new Error(`Discord webhook returned ${response.status}`)
  }
}

/**
 * Handle one Wikidata edit for one account: parse, match, and post a
 * Discord notice. Returns a result object on a match (with noop flag when
 * not posting), null when the edit doesn't match or was rate-capped.
 *
 * @param {Object} account - Account config (discord + wikidata_claims)
 * @param {Object} edit - wikichanges-shaped edit from the stream
 * @param {Object} deps
 * @param {{places: Set, positions: Set}} deps.sets - Current target sets
 * @param {boolean} [deps.noop] - Log matches without posting
 * @param {RateCap} [deps.rateCap] - Shared per-account rate cap
 * @returns {Promise<Object|null>}
 */
async function handleWikidataEdit(account, edit, { sets, noop = false, rateCap = null }) {
  const claimsConfig = account.wikidata_claims
  if (!claimsConfig || !account.discord?.webhook_url) return null

  const parsed = parseClaimEdit(edit.comment)
  if (!parsed) return null

  const hit = matchClaim(parsed, sets, claimsConfig)
  if (!hit) return null

  const match = { ...parsed, ...hit, page: edit.page }

  if (noop) {
    console.log(`[claim-watch] (noop) ${edit.page}: ${parsed.property} -> ${parsed.value} ${parsed.action}`)
    return { ...match, noop: true }
  }

  if (rateCap && !rateCap.tryTake()) {
    console.log(`[claim-watch] rate-capped: ${edit.page} ${parsed.property} ${parsed.action}`)
    return null
  }

  const labels = await fetchLabels([edit.page, parsed.value, parsed.property])

  const action = ACTION_LABELS[parsed.action] || `**${parsed.action}**`
  const embed = {
    title: labels[edit.page],
    url: edit.url,
    description:
      `${action} — **${labels[parsed.property]}**: ${labels[parsed.value]}` +
      `\nby [${edit.user}](${encodeURI(edit.userUrl)})`,
    color: EMBED_COLORS[parsed.action] || 0x95a5a6,
    author: { name: 'Wikidata', url: 'https://www.wikidata.org', icon_url: WIKIDATA_ICON }
  }

  await postToWebhook(account.discord.webhook_url, { embeds: [embed] })

  // Surface anything suppressed during the previous window
  if (rateCap) {
    const missed = rateCap.drainSuppressed()
    if (missed > 0) {
      await postToWebhook(account.discord.webhook_url, {
        embeds: [{
          description: `…and ${missed} more Bay Area claim change${missed === 1 ? '' : 's'} (rate cap)`,
          color: 0x95a5a6
        }]
      }).catch(e => console.error('[claim-watch] summary post failed:', e.message))
    }
  }

  console.log(`[claim-watch] posted: ${labels[edit.page]} ${labels[parsed.property]} ${parsed.action}`)
  return match
}

/**
 * Build initial target sets and schedule periodic refreshes for every
 * account with a wikidata_claims stanza. State (sets + rate cap) is
 * attached to the account as account.claimWatch - the same mutate-the-
 * account pattern the dynamic watchlist uses - so the edit router can
 * reach it without extra bookkeeping.
 *
 * @param {Object} config - Full bot config
 * @param {Object} opts
 * @param {string} opts.dataDir - Directory for cache files
 * @returns {Promise<NodeJS.Timeout[]>} Refresh timers (unref'd)
 */
async function startClaimWatch(config, { dataDir }) {
  const timers = []

  for (const account of config.accounts || []) {
    if (!account.wikidata_claims) continue

    const claimsConfig = account.wikidata_claims
    const sets = await refreshTargetSets(claimsConfig, { dataDir })
    const capConfig = { ...DEFAULT_RATE_CAP, ...(claimsConfig.rate_cap || {}) }
    account.claimWatch = {
      sets,
      rateCap: new RateCap({
        max: capConfig.max,
        windowMs: capConfig.window_minutes * 60 * 1000
      })
    }

    const hours = claimsConfig.refresh_hours || DEFAULT_REFRESH_HOURS
    const timer = setInterval(() => {
      refreshTargetSets(claimsConfig, { dataDir })
        .then(fresh => { account.claimWatch.sets = fresh })
        .catch(e => console.error('Claim-target refresh error:', e.message))
    }, hours * 60 * 60 * 1000)
    timer.unref()
    timers.push(timer)
  }

  return timers
}

module.exports = {
  parseClaimEdit,
  matchClaim,
  RateCap,
  refreshTargetSets,
  fetchLabels,
  handleWikidataEdit,
  startClaimWatch,
  BAY_AREA_COUNTIES,
  DEFAULT_PROPERTIES
}
