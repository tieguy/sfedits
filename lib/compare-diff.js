/**
 * Structured diff via the MediaWiki REST compare API
 *
 * Fetches the wikidiff2 JSON diff for an edit and turns it into:
 *  - a compact, readable HTML rendering (screenshotted for posts)
 *  - mechanical alt text describing what changed
 *
 * @see https://www.mediawiki.org/wiki/API:REST_API/Reference#Compare_revisions
 */

const { userAgent } = require('./user-agent')
const USER_AGENT = userAgent('compare-diff')
const FETCH_TIMEOUT_MS = 15000

// wikidiff2 line types
const TYPE_CONTEXT = 0
const TYPE_ADD = 1
const TYPE_DELETE = 2
const TYPE_CHANGE = 3
const TYPE_MOVE_TARGET = 4
const TYPE_MOVE_SOURCE = 5

// highlightRanges types (within TYPE_CHANGE / TYPE_MOVE_TARGET lines)
const HIGHLIGHT_ADD = 0
const HIGHLIGHT_DELETE = 1

const MAX_RENDERED_LINES = 50
const MAX_ALT_TEXT_LENGTH = 1200

// Rendering caps: Wikipedia paragraphs arrive as single diff "lines", so
// long lines are clipped (context) or windowed around highlights (changes)
// to keep images readable.
const MAX_CONTEXT_CHARS = 200
const MAX_PLAIN_LINE_CHARS = 700
const HIGHLIGHT_WINDOW_CHARS = 150

/**
 * Extract host and revision ids from a Wikipedia diff URL
 * (e.g. https://en.wikipedia.org/w/index.php?diff=123&oldid=456).
 * @returns {{host: string, torev: number, fromrev: number|null}|null}
 */
function parseDiffParams(diffUrl) {
  let url
  try {
    url = new URL(diffUrl)
  } catch (e) {
    return null
  }
  const torev = parseInt(url.searchParams.get('diff'), 10)
  const fromrev = parseInt(url.searchParams.get('oldid'), 10)
  if (!Number.isInteger(torev)) return null
  return {
    host: url.host,
    torev,
    fromrev: Number.isInteger(fromrev) ? fromrev : null
  }
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

/**
 * Look up the parent revision id when the diff URL lacks oldid.
 */
async function fetchParentRevision(host, revid) {
  const url = `https://${host}/w/api.php?action=query&prop=revisions&revids=${revid}&rvprop=ids&format=json`
  const data = await fetchJson(url)
  const pages = data?.query?.pages || {}
  for (const pageId of Object.keys(pages)) {
    const rev = pages[pageId]?.revisions?.[0]
    if (rev && Number.isInteger(rev.parentid) && rev.parentid > 0) {
      return rev.parentid
    }
  }
  return null
}

/**
 * Fetch the structured wikidiff2 diff for a diff URL.
 * Returns the array of diff line objects, or null if unavailable.
 */
async function fetchCompareDiff(diffUrl) {
  const params = parseDiffParams(diffUrl)
  if (!params) return null

  let { host, torev, fromrev } = params
  if (!fromrev) {
    fromrev = await fetchParentRevision(host, torev)
    if (!fromrev) return null
  }

  const url = `https://${host}/w/rest.php/v1/revision/${fromrev}/compare/${torev}`
  const data = await fetchJson(url)
  return Array.isArray(data?.diff) ? data.diff : null
}

// Private-use sentinel characters used to protect highlight boundaries
// while wikitext stripping runs over a whole line.
const INS_OPEN = ''
const INS_CLOSE = ''
const DEL_OPEN = ''
const DEL_CLOSE = ''
const TPL_OPEN = ''
const TPL_CLOSE = ''
const SENTINEL_RE = /[-]/
const ALL_MARKERS_RE = /[-]/g

function hasSentinel(text) {
  return SENTINEL_RE.test(text)
}

// Matches complete highlighted spans: INS_OPEN..INS_CLOSE or DEL_OPEN..DEL_CLOSE
const HIGHLIGHT_SPAN_RE = new RegExp(
  `${INS_OPEN}[^${INS_CLOSE}]*${INS_CLOSE}|${DEL_OPEN}[^${DEL_CLOSE}]*${DEL_CLOSE}`, 'g'
)

/**
 * Collapse a ref. An untouched (or wholly added/removed) ref becomes
 * [ref]; a ref the edit reached *inside* keeps only its changed
 * fragments: [ref: <fragments>]. If a highlight span crosses the ref
 * boundary the ref is left raw — never risk hiding the change.
 */
function collapseRef(match) {
  if (!hasSentinel(match)) return '[ref]'
  const fragments = match.match(HIGHLIGHT_SPAN_RE)
  if (!fragments) return match
  const residue = match.replace(HIGHLIGHT_SPAN_RE, '')
  if (hasSentinel(residue)) return match
  return `[ref: ${fragments.join(' ')}]`
}

// Cite-template parameters naming the publication, in display-preference
// order: the work/site name usually identifies a source better than the
// corporate publisher.
const REF_SOURCE_PARAMS = ['work', 'website', 'newspaper', 'journal', 'magazine', 'publisher']
const REF_TITLE_CHARS = 60

/**
 * Pull one named parameter's value out of a cite-template body. Piped
 * wikilinks are matched atomically so a | inside [[...]] doesn't
 * terminate the value, then unwrapped to their labels.
 */
function citeParam(body, name) {
  const re = new RegExp(`\\|\\s*${name}\\s*=\\s*((?:\\[\\[[^\\[\\]]*\\]\\]|[^|{}\\[\\]<]+)+)`, 'i')
  const m = body.match(re)
  if (!m) return null
  const value = m[1]
    .replace(/\[\[(?:[^\[\]|]*\|)?([^\[\]]*)\]\]/g, '$1')
    .replace(/'{2,5}/g, '')
    .trim()
  return value || null
}

/**
 * The hostname a ref cites, from its |url= parameter or the first bare
 * URL in its body.
 */
function refUrlHost(body) {
  const url = citeParam(body, 'url') || (body.match(/https?:\/\/[^\s<>|\]}"']+/) || [])[0]
  if (!url || !/^https?:\/\//.test(url)) return null
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (e) {
    return null
  }
}

/**
 * Compact citation gloss for a ref that IS the change (added or removed
 * whole): what was cited, not just that something was. The title and
 * publication come straight from the cite template's own parameters (or
 * an external-link label / the URL's hostname), so no citoid/network
 * lookup is needed. Falls back to the ref's prose for template-free
 * citations, and to plain [ref] when nothing quotable is found.
 */
function describeRef(match) {
  const body = match.replace(/^<ref\b[^>]*>/i, '').replace(/<\/ref\s*>$/i, '')

  const extLink = body.match(/\[https?:\/\/[^\s\]]+ +([^\]]+)\]/)
  const title = citeParam(body, 'title') || (extLink ? extLink[1].trim() : null)

  let source = null
  for (const name of REF_SOURCE_PARAMS) {
    source = citeParam(body, name)
    if (source) break
  }
  if (!source) source = refUrlHost(body)

  const parts = []
  if (title && title !== source) parts.push(`"${truncate(title, REF_TITLE_CHARS)}"`)
  if (source) parts.push(parts.length ? `(${source})` : source)
  if (!parts.length && !/[{}]/.test(body)) {
    // No cite template at all: a plain-prose citation - quote the prose
    const prose = body
      .replace(/\[\[(?:[^\[\]|]*\|)?([^\[\]]*)\]\]/g, '$1')
      .replace(/'{2,5}/g, '')
      .replace(/<[^>]*>/g, '')
      .trim()
    if (prose) parts.push(truncate(prose, REF_TITLE_CHARS))
  }
  return parts.length ? `[ref: ${parts.join(' ')}]` : '[ref]'
}

/**
 * True when position `offset` in sentinel-marked text falls inside an
 * INS/DEL highlight span — i.e. the construct at that position is part
 * of the edit itself, not surrounding context.
 */
function insideHighlight(text, offset) {
  for (let i = offset - 1; i >= 0; i--) {
    const ch = text[i]
    if (ch === INS_OPEN || ch === DEL_OPEN) return true
    if (ch === INS_CLOSE || ch === DEL_CLOSE) return false
  }
  return false
}

/**
 * Reduce raw wikitext markup to readable text: refs collapse to [ref],
 * links unwrap to their labels, templates collapse to {{name}}, quote
 * markup and inline HTML disappear.
 *
 * Any construct containing a highlight sentinel is left untouched, so an
 * edit *inside* a ref/template/link target is never stripped out of view.
 * A construct wholly inside a highlight has no sentinel within it and
 * still collapses — but a ref that IS the change collapses to a citation
 * gloss (see describeRef) rather than an uninformative [ref]. Context
 * refs stay [ref]. opts.glossRefs forces the gloss when the caller knows
 * the whole text is changed (wholly added/removed lines carry no
 * sentinels).
 */
function stripWikitext(text, opts = {}) {
  let t = text

  // References
  t = t.replace(/<ref\b[^>]*\/\s*>/gi, m => hasSentinel(m) ? m : '[ref]')
  t = t.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, (m, offset, s) => {
    if (hasSentinel(m)) return collapseRef(m)
    if (opts.glossRefs || insideHighlight(s, offset)) return describeRef(m)
    return '[ref]'
  })

  // HTML comments
  t = t.replace(/<!--[\s\S]*?-->/g, m => hasSentinel(m) ? m : '')

  // Templates, innermost first: each pass collapses brace-free templates
  // into placeholder tokens so enclosing templates match on the next pass.
  let prev
  do {
    prev = t
    t = t.replace(/\{\{([^{}|]*)((?:\|[^{}]*)?)\}\}/g,
      (m, name) => hasSentinel(m) ? m : `${TPL_OPEN}${name.trim()}${TPL_CLOSE}`)
  } while (t !== prev)
  do {
    prev = t
    t = t.replace(/([^]*)/g, '{{$1}}')
  } while (t !== prev)

  // File/image links, then piped links ([[target|label]] -> label, unless
  // the change is in the target), then plain links ([[x]] -> x)
  t = t.replace(/\[\[(?:File|Image):[^\[\]]*\]\]/gi, m => hasSentinel(m) ? m : '[image]')
  t = t.replace(/\[\[([^\[\]|]*)\|([^\[\]]*)\]\]/g,
    (m, target, label) => hasSentinel(target) ? m : label)
  t = t.replace(/\[\[([^\[\]|]*)\]\]/g, '$1')

  // External links: [https://url label] -> label
  t = t.replace(/\[https?:\/\/[^\s\]]+\s+([^\]]*)\]/g, '$1')

  // Bold/italic quote markup and simple inline HTML
  t = t.replace(/'{2,5}/g, '')
  t = t.replace(/<\/?(?:small|big|br|span|div|sub|sup|u|s|code|nowiki|blockquote)\b[^>]*\/?>/gi, '')
  t = t.replace(/&nbsp;/g, ' ')

  return t
}

/**
 * Run wikitext stripping across a changed line without losing highlight
 * boundaries: join segments with sentinel markers, strip, re-split.
 *
 * If the edit consisted purely of markup that stripping removes (e.g.
 * wrapping a word in [[..]] link brackets), stripped output would show a
 * changed line with nothing highlighted — so fall back to the raw
 * segments and let the markup change stay visible.
 */
function stripSegments(segments) {
  const stripped = stripSegmentsRaw(segments)
  const hadVisibleChange = segments.some(s => s.highlight && s.text.trim())
  const hasVisibleChange = stripped.some(s => s.highlight && s.text.trim())
  return (hadVisibleChange && !hasVisibleChange) ? segments : stripped
}

function stripSegmentsRaw(segments) {
  const joined = segments.map(seg => {
    const clean = seg.text.replace(ALL_MARKERS_RE, '')
    if (seg.highlight === 'add') return INS_OPEN + clean + INS_CLOSE
    if (seg.highlight === 'delete') return DEL_OPEN + clean + DEL_CLOSE
    return clean
  }).join('')

  const stripped = stripWikitext(joined)

  const out = []
  let mode = null
  let buf = ''
  const flush = () => {
    if (buf) out.push({ text: buf, highlight: mode })
    buf = ''
  }
  for (const ch of stripped) {
    if (ch === INS_OPEN) { flush(); mode = 'add' }
    else if (ch === DEL_OPEN) { flush(); mode = 'delete' }
    else if (ch === INS_CLOSE || ch === DEL_CLOSE) { flush(); mode = null }
    else buf += ch
  }
  flush()
  return out
}

/**
 * Fetch the page summary (lead image thumbnail + Wikidata description)
 * for an article. Fail-soft: returns nulls on any error so posting is
 * never blocked by a missing summary.
 * @returns {Promise<{description: string|null, thumbnailUrl: string|null}>}
 */
async function fetchPageSummary(host, page) {
  try {
    const url = `https://${host}/api/rest_v1/page/summary/${encodeURIComponent(page.replace(/ /g, '_'))}`
    const data = await fetchJson(url)
    return {
      description: data?.description || null,
      thumbnailUrl: data?.thumbnail?.source || null
    }
  } catch (e) {
    return { description: null, thumbnailUrl: null }
  }
}

// WP:BDP: BLP protection extends "for some time" past death (six months
// to two years at editorial discretion) - use the conservative end.
const BDP_WINDOW_MS = 2 * 365 * 24 * 60 * 60 * 1000

const WIKIDATA_HUMAN = 'Q5'
const P_INSTANCE_OF = 'P31'
const P_DATE_OF_DEATH = 'P570'

/**
 * Decide BLP status from Wikidata claim values. Pure function.
 * @param {string[]} instanceOfIds - Q-ids from P31 claims
 * @param {string|null} deathTime - Wikidata time string from P570 (e.g.
 *   "+2023-09-29T00:00:00Z"), or null if no death date
 * @param {Date} [now] - Injectable clock for tests
 * @returns {{isBlp: boolean, reason: 'living'|'recently-deceased'|null}}
 */
function blpFromClaims(instanceOfIds, deathTime, now = new Date()) {
  if (!instanceOfIds.includes(WIKIDATA_HUMAN)) {
    return { isBlp: false, reason: null }
  }
  if (!deathTime) {
    return { isBlp: true, reason: 'living' }
  }
  const m = deathTime.match(/^[+-]?(\d+)-(\d{2})-(\d{2})/)
  if (m) {
    const died = Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1 || 0, parseInt(m[3], 10) || 1)
    if (now.getTime() - died < BDP_WINDOW_MS) {
      return { isBlp: true, reason: 'recently-deceased' }
    }
  }
  return { isBlp: false, reason: null }
}

/**
 * Check whether an article is subject to the BLP policy, via Wikidata:
 * instance-of human with no date of death (or a death within the WP:BDP
 * window). Works on any language wiki. Fail-soft: returns
 * {isBlp: null, reason: null} when the status can't be determined.
 */
async function fetchBlpStatus(host, page) {
  try {
    const ppUrl = `https://${host}/w/api.php?action=query&titles=${encodeURIComponent(page)}` +
      `&prop=pageprops&ppprop=wikibase_item&format=json&formatversion=2`
    const ppData = await fetchJson(ppUrl)
    const pageInfo = ppData?.query?.pages?.[0]
    const qid = pageInfo?.pageprops?.wikibase_item
    if (!qid) {
      // Distinguish "article exists but has no Wikidata item" (a fixable
      // gap worth surfacing - BLP status is unknowable without an item)
      // from "couldn't check"
      const missingItem = Boolean(pageInfo && !pageInfo.missing)
      return { isBlp: null, reason: null, qid: null, missingItem }
    }

    const claimsUrl = (prop) =>
      `https://www.wikidata.org/w/api.php?action=wbgetclaims&entity=${qid}&property=${prop}&format=json`
    const [p31, p570] = await Promise.all([
      fetchJson(claimsUrl(P_INSTANCE_OF)),
      fetchJson(claimsUrl(P_DATE_OF_DEATH))
    ])

    const instanceOfIds = (p31?.claims?.[P_INSTANCE_OF] || [])
      .map(c => c?.mainsnak?.datavalue?.value?.id)
      .filter(Boolean)
    const deathTime = (p570?.claims?.[P_DATE_OF_DEATH] || [])
      .map(c => c?.mainsnak?.datavalue?.value?.time)
      .filter(Boolean)[0] || null

    // qid is included so consumers can link to the Wikidata item - e.g.
    // a dead person flagged as BLP means P570 is missing and one click
    // away from fixable
    return { ...blpFromClaims(instanceOfIds, deathTime), qid, missingItem: false }
  } catch (e) {
    return { isBlp: null, reason: null, qid: null, missingItem: false }
  }
}

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

/**
 * Fetch an image and return it as a data: URI so the rendered HTML is
 * self-contained (no network dependency at screenshot time).
 * Fail-soft: returns null on any error or oversized/non-image response.
 */
async function fetchImageAsDataUri(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    })
    if (!res.ok) return null
    const type = res.headers.get('content-type') || ''
    if (!/^image\/(jpeg|png|gif|webp)/.test(type)) return null
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length === 0 || buf.length > MAX_THUMBNAIL_BYTES) return null
    return `data:${type.split(';')[0]};base64,${buf.toString('base64')}`
  } catch (e) {
    return null
  }
}

/**
 * Split a changed line's text into segments using its highlightRanges.
 * wikidiff2 highlight offsets/lengths are BYTE offsets into the UTF-8 text.
 * Returns [{text, highlight: null|'add'|'delete'}, ...] in order.
 */
function splitHighlights(text, highlightRanges) {
  const buf = Buffer.from(text, 'utf8')
  const segments = []
  let pos = 0
  const ranges = (highlightRanges || []).slice().sort((a, b) => a.start - b.start)
  for (const range of ranges) {
    const start = Math.max(0, Math.min(range.start, buf.length))
    const end = Math.max(start, Math.min(range.start + range.length, buf.length))
    if (start > pos) {
      segments.push({ text: buf.toString('utf8', pos, start), highlight: null })
    }
    if (end > start) {
      segments.push({
        text: buf.toString('utf8', start, end),
        highlight: range.type === HIGHLIGHT_DELETE ? 'delete' : 'add'
      })
    }
    pos = Math.max(pos, end)
  }
  if (pos < buf.length) {
    segments.push({ text: buf.toString('utf8', pos), highlight: null })
  }
  return segments
}

// Interior unchanged stretch inside a changed-line excerpt: short ones are
// kept whole so the excerpt reads as a phrase; long ones keep only their
// ends so two far-apart changes don't drag a whole paragraph into the
// excerpt.
const EXCERPT_GAP_CHARS = 120

function shortenGap(text) {
  if (text.length <= EXCERPT_GAP_CHARS) return text
  const keep = Math.floor(EXCERPT_GAP_CHARS / 2)
  return `${text.slice(0, keep)} … ${text.slice(-keep)}`
}

/**
 * One readable excerpt for one side ('add' | 'delete') of a changed line.
 *
 * Quoting each highlight range in isolation turns a multi-range edit (a
 * link cleanup, a few word swaps in one sentence) into confetti like
 * "director … finance … [[ … organization". Instead: drop the other
 * side's segments so only this side's version of the line remains, strip
 * wikitext across the whole line at once (markup spanning several ranges
 * collapses cleanly), and excerpt from the first changed range to the
 * last, keeping the unchanged words in between.
 *
 * @returns {string|null} The excerpt, or null when this side has no
 *   visible change on the line
 */
function changedLineExcerpt(segments, side) {
  const opposite = side === 'add' ? 'delete' : 'add'
  const kept = stripSegments(segments.filter(seg => seg.highlight !== opposite))
  const isChange = seg => seg.highlight === side && seg.text.trim()
  const first = kept.findIndex(isChange)
  if (first === -1) return null
  let last = first
  for (let i = kept.length - 1; i > first; i--) {
    if (isChange(kept[i])) { last = i; break }
  }
  const span = kept.slice(first, last + 1)
    .map(seg => seg.highlight ? seg.text : shortenGap(seg.text))
    .join('')
  return span.replace(/\s+/g, ' ').trim() || null
}

/**
 * Collect the added and removed text fragments across the whole diff.
 *
 * `added`/`removed` are flat per-highlight fragments (used for alt text and
 * markup classification). `addedLines`/`removedLines` carry one readable
 * excerpt per source line (see changedLineExcerpt), so display surfaces
 * (Discord embeds) put one diff line on one line with its surrounding
 * words intact.
 */
function extractChangedText(diff) {
  const added = []
  const removed = []
  const addedLines = []
  const removedLines = []
  for (const line of diff) {
    if (line.type === TYPE_ADD) {
      const t = stripWikitext(line.text, { glossRefs: true }).trim()
      if (t) { added.push(t); addedLines.push(t) }
    } else if (line.type === TYPE_DELETE) {
      const t = stripWikitext(line.text, { glossRefs: true }).trim()
      if (t) { removed.push(t); removedLines.push(t) }
    } else if (line.type === TYPE_CHANGE || line.type === TYPE_MOVE_TARGET) {
      const segments = splitHighlights(line.text, line.highlightRanges)
      for (const seg of stripSegments(segments)) {
        const t = seg.text.trim()
        if (!t) continue
        if (seg.highlight === 'add') added.push(t)
        else if (seg.highlight === 'delete') removed.push(t)
      }
      const addedExcerpt = changedLineExcerpt(segments, 'add')
      const removedExcerpt = changedLineExcerpt(segments, 'delete')
      if (addedExcerpt) addedLines.push(addedExcerpt)
      if (removedExcerpt) removedLines.push(removedExcerpt)
    }
  }
  return { added, removed, addedLines, removedLines }
}

/**
 * True for changed lines whose highlighted segments are all whitespace
 * (e.g. infobox parameter realignment) — visually meaningless noise.
 */
function isWhitespaceOnlyChange(line) {
  if (line.type !== TYPE_CHANGE && line.type !== TYPE_MOVE_TARGET) return false
  if (!line.highlightRanges || line.highlightRanges.length === 0) return false
  return splitHighlights(line.text, line.highlightRanges)
    .every(seg => !seg.highlight || !seg.text.trim())
}

function truncate(text, max) {
  if (text.length <= max) return text
  return text.slice(0, max - 1) + '…'
}

// Recognizable markup-only fragments (surviving via the raw-markup
// fallback) that would read as gibberish in alt text.
const MARKUP_FRAGMENT_KINDS = [
  [/^[\[\]]+$/, 'link markup'],
  [/^<br\s*\/?\s*>$/i, 'line breaks'],
  [/^'{2,5}$/, 'text styling'],
  [/^[{}|=]+$/, 'template markup']
]

function markupKind(fragment) {
  const t = fragment.trim()
  for (const [re, kind] of MARKUP_FRAGMENT_KINDS) {
    if (re.test(t)) return kind
  }
  return null
}

/**
 * Split fragments into quotable text and described markup kinds, so alt
 * text says "changes to link markup" instead of quoting "[[ … ]]".
 */
function classifyFragments(fragments) {
  const quotable = []
  const markup = new Set()
  for (const f of fragments) {
    const kind = markupKind(f)
    if (kind) markup.add(kind)
    else quotable.push(f)
  }
  return { quotable, markup }
}

/**
 * Structured summary of a diff: line counts, a human-readable sentence,
 * and the (wikitext-stripped) added/removed text fragments. Used for alt
 * text and for rich platform output (e.g. Discord embeds).
 */
function summarizeDiff(diff) {
  const counts = { added: 0, removed: 0, changed: 0, whitespace: 0 }
  for (const line of diff) {
    if (line.type === TYPE_ADD) counts.added++
    else if (line.type === TYPE_DELETE) counts.removed++
    else if (line.type === TYPE_CHANGE || line.type === TYPE_MOVE_TARGET) {
      if (isWhitespaceOnlyChange(line)) counts.whitespace++
      else counts.changed++
    }
  }

  const parts = []
  if (counts.added) parts.push(`${counts.added} line${counts.added === 1 ? '' : 's'} added`)
  if (counts.removed) parts.push(`${counts.removed} line${counts.removed === 1 ? '' : 's'} removed`)
  if (counts.changed) parts.push(`${counts.changed} line${counts.changed === 1 ? '' : 's'} changed`)
  let sentence
  if (parts.length) sentence = parts.join(', ')
  else if (counts.whitespace) sentence = 'whitespace and formatting changes only'
  else sentence = 'no visible text changes'

  const { added, removed, addedLines, removedLines } = extractChangedText(diff)
  return { counts, sentence, added, removed, addedLines, removedLines }
}

/**
 * Build mechanical alt text describing the diff.
 * No LLM involved: counts of changed lines plus excerpts of the
 * actual added/removed text.
 */
function buildAltText(diff, page, description = null) {
  const { sentence: summary, added, removed } = summarizeDiff(diff)

  const subject = description ? `"${page}" (${description})` : `"${page}"`
  let alt = `Diff of Wikipedia article ${subject}: ${summary}.`

  const addedClass = classifyFragments(added)
  const removedClass = classifyFragments(removed)

  const budget = MAX_ALT_TEXT_LENGTH - alt.length
  if (budget > 60) {
    const half = Math.floor(budget / 2) - 20
    if (addedClass.quotable.length) {
      alt += ` Added text: "${truncate(addedClass.quotable.join(' … '), half)}"`
    }
    if (removedClass.quotable.length) {
      alt += ` Removed text: "${truncate(removedClass.quotable.join(' … '), half)}"`
    }
  }

  const markupKinds = [...new Set([...addedClass.markup, ...removedClass.markup])]
  if (markupKinds.length) {
    const hasQuotable = addedClass.quotable.length || removedClass.quotable.length
    alt += hasQuotable
      ? ` Also changes to ${markupKinds.join(' and ')}.`
      : ` Changes are to ${markupKinds.join(' and ')} only.`
  }

  return truncate(alt, MAX_ALT_TEXT_LENGTH)
}

/**
 * Shorten the unhighlighted stretches of a long changed line, keeping a
 * window of text around each highlight so the change stays in context.
 */
function compressSegments(segments, window = HIGHLIGHT_WINDOW_CHARS) {
  const total = segments.reduce((n, s) => n + s.text.length, 0)
  if (total <= MAX_PLAIN_LINE_CHARS) return segments

  return segments.map((seg, i) => {
    if (seg.highlight) return seg
    // Keep text adjacent to highlights: the tail leading into the next
    // segment and the head trailing the previous one.
    const keepHead = i > 0 ? window : 0
    const keepTail = i < segments.length - 1 ? window : 0
    if (seg.text.length <= keepHead + keepTail + 20) return seg
    const head = keepHead ? seg.text.slice(0, keepHead) : ''
    const tail = keepTail ? seg.text.slice(-keepTail) : ''
    return { text: `${head} […] ${tail}`, highlight: null }
  })
}

/**
 * Whitespace-only highlighted segments (e.g. infobox realignment) render
 * as distracting colored blobs; demote them to plain text.
 */
function displaySegments(text, highlightRanges) {
  const segments = stripSegments(splitHighlights(text, highlightRanges))
  return compressSegments(segments).map(seg =>
    seg.text.trim() ? seg : { ...seg, highlight: null }
  )
}

/**
 * Renderer-independent model of the diff image: header meta plus rows of
 * styled text segments. Consumed by lib/diff-render-native.js (satori/resvg,
 * no browser).
 *
 * Row kinds: 'add' | 'delete' | 'change' | 'context' | 'gap' | 'footer'.
 * Segment highlight: null | 'add' | 'delete'.
 */
function buildDiffModel(diff, page, meta = {}) {
  const rows = []
  let prevLineNumber = null
  let shown = 0
  let omitted = 0

  const plainRow = (kind, gutter, text, max) => ({
    kind,
    gutter,
    // Whole added/removed lines ARE the change, so their refs get the
    // citation gloss; context lines keep the terse [ref].
    segments: [{
      text: truncate(stripWikitext(text, { glossRefs: kind === 'add' || kind === 'delete' }), max),
      highlight: null
    }]
  })

  for (const line of diff) {
    // Whitespace-only realignments (common in infobox edits) are noise
    if (isWhitespaceOnlyChange(line)) continue

    if (shown >= MAX_RENDERED_LINES) {
      if (line.type !== TYPE_CONTEXT) omitted++
      continue
    }

    // Divider between non-contiguous chunks
    if (prevLineNumber !== null && line.lineNumber && line.lineNumber > prevLineNumber + 1) {
      rows.push({ kind: 'gap', gutter: '', segments: [{ text: '⋯', highlight: null }] })
    }
    if (line.lineNumber) prevLineNumber = line.lineNumber

    switch (line.type) {
      case TYPE_ADD:
        rows.push(plainRow('add', '+', line.text, MAX_PLAIN_LINE_CHARS))
        break
      case TYPE_DELETE:
      case TYPE_MOVE_SOURCE:
        rows.push(plainRow('delete', '−', line.text, MAX_PLAIN_LINE_CHARS))
        break
      case TYPE_CHANGE:
      case TYPE_MOVE_TARGET:
        rows.push({ kind: 'change', gutter: '±', segments: displaySegments(line.text, line.highlightRanges) })
        break
      default:
        rows.push(plainRow('context', '', line.text, MAX_CONTEXT_CHARS))
    }
    shown++
  }

  if (omitted > 0) {
    rows.push({
      kind: 'footer',
      gutter: '',
      segments: [{ text: `… and ${omitted} more changed line${omitted === 1 ? '' : 's'}`, highlight: null }]
    })
  }

  return {
    page,
    description: meta.description || null,
    imageDataUri: meta.imageDataUri || null,
    rows
  }
}

module.exports = {
  parseDiffParams,
  fetchCompareDiff,
  fetchPageSummary,
  fetchImageAsDataUri,
  splitHighlights,
  summarizeDiff,
  buildAltText,
  blpFromClaims,
  fetchBlpStatus,
  buildDiffModel
}
