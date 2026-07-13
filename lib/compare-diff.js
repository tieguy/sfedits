/**
 * Structured diff via the MediaWiki REST compare API
 *
 * Fetches the wikidiff2 JSON diff for an edit and turns it into:
 *  - a compact, readable HTML rendering (screenshotted for posts)
 *  - mechanical alt text describing what changed
 *
 * @see https://www.mediawiki.org/wiki/API:REST_API/Reference#Compare_revisions
 */

const USER_AGENT = 'sfedits-bot/1.0 (https://github.com/edsu/anon; Contact via GitHub issues)'
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

/**
 * Reduce raw wikitext markup to readable text: refs collapse to [ref],
 * links unwrap to their labels, templates collapse to {{name}}, quote
 * markup and inline HTML disappear.
 *
 * Any construct containing a highlight sentinel is left untouched, so an
 * edit *inside* a ref/template/link target is never stripped out of view.
 * A construct wholly inside a highlight has no sentinel within it and
 * still collapses (e.g. an added citation renders as a highlighted [ref]).
 */
function stripWikitext(text) {
  let t = text

  // References
  t = t.replace(/<ref\b[^>]*\/\s*>/gi, m => hasSentinel(m) ? m : '[ref]')
  t = t.replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, collapseRef)

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

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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

/**
 * Collect the added and removed text fragments across the whole diff.
 * Used for alt text.
 */
function extractChangedText(diff) {
  const added = []
  const removed = []
  for (const line of diff) {
    if (line.type === TYPE_ADD) {
      const t = stripWikitext(line.text).trim()
      if (t) added.push(t)
    } else if (line.type === TYPE_DELETE) {
      const t = stripWikitext(line.text).trim()
      if (t) removed.push(t)
    } else if (line.type === TYPE_CHANGE || line.type === TYPE_MOVE_TARGET) {
      for (const seg of stripSegments(splitHighlights(line.text, line.highlightRanges))) {
        const t = seg.text.trim()
        if (!t) continue
        if (seg.highlight === 'add') added.push(t)
        else if (seg.highlight === 'delete') removed.push(t)
      }
    }
  }
  return { added, removed }
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

  const { added, removed } = extractChangedText(diff)
  return { counts, sentence, added, removed }
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

function renderSegments(text, highlightRanges) {
  const segments = stripSegments(splitHighlights(text, highlightRanges))
  return compressSegments(segments).map(seg => {
    const escaped = escapeHtml(seg.text)
    // Whitespace-only changes (e.g. infobox realignment) render as
    // distracting colored blobs; show them as plain text instead.
    if (!seg.text.trim()) return escaped
    if (seg.highlight === 'add') return `<ins>${escaped}</ins>`
    if (seg.highlight === 'delete') return `<del>${escaped}</del>`
    return escaped
  }).join('')
}

/**
 * Render the structured diff as a self-contained HTML document with a
 * compact single-column (inline) layout: full added/removed lines get
 * +/− gutters, changed lines show word-level <ins>/<del> highlights.
 *
 * Optional meta enriches the header:
 *   - description: Wikidata short description of the article's subject
 *   - imageDataUri: article lead image as a data: URI
 */
function renderDiffHtml(diff, page, meta = {}) {
  const rows = []
  let prevLineNumber = null
  let shown = 0
  let omitted = 0

  for (const line of diff) {
    // Whitespace-only realignments (common in infobox edits) are noise
    if (isWhitespaceOnlyChange(line)) continue

    if (shown >= MAX_RENDERED_LINES) {
      if (line.type !== TYPE_CONTEXT) omitted++
      continue
    }

    // Divider between non-contiguous chunks
    if (prevLineNumber !== null && line.lineNumber && line.lineNumber > prevLineNumber + 1) {
      rows.push('<div class="row gap"><span class="gutter"></span><span class="text">⋯</span></div>')
    }
    if (line.lineNumber) prevLineNumber = line.lineNumber

    let cls, gutter, content
    switch (line.type) {
      case TYPE_ADD:
        cls = 'add'; gutter = '+'; content = escapeHtml(truncate(stripWikitext(line.text), MAX_PLAIN_LINE_CHARS))
        break
      case TYPE_DELETE:
      case TYPE_MOVE_SOURCE:
        cls = 'delete'; gutter = '−'; content = escapeHtml(truncate(stripWikitext(line.text), MAX_PLAIN_LINE_CHARS))
        break
      case TYPE_CHANGE:
      case TYPE_MOVE_TARGET:
        cls = 'change'; gutter = '±'; content = renderSegments(line.text, line.highlightRanges)
        break
      default:
        cls = 'context'; gutter = ''; content = escapeHtml(truncate(stripWikitext(line.text), MAX_CONTEXT_CHARS))
    }
    rows.push(`<div class="row ${cls}"><span class="gutter">${gutter}</span><span class="text">${content || '&nbsp;'}</span></div>`)
    shown++
  }

  if (omitted > 0) {
    rows.push(`<div class="row footer"><span class="gutter"></span><span class="text">… and ${omitted} more changed line${omitted === 1 ? '' : 's'}</span></div>`)
  }

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #ffffff; }
  #diff {
    width: 1000px;
    box-sizing: border-box;
    padding: 20px 24px;
    font-family: -apple-system, "Segoe UI", "Helvetica Neue", Arial, sans-serif;
    font-size: 17px;
    line-height: 1.45;
    color: #202122;
  }
  header {
    display: flex;
    align-items: center;
    gap: 16px;
    margin-bottom: 14px;
    padding-bottom: 12px;
    border-bottom: 1px solid #c8ccd1;
  }
  .heading { flex: 1; min-width: 0; }
  .eyebrow {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: #72777d;
    margin: 0 0 2px 0;
  }
  h1 {
    font-size: 22px;
    font-weight: 600;
    margin: 0;
  }
  .description {
    font-size: 15px;
    color: #54595d;
    margin: 3px 0 0 0;
  }
  .thumb {
    flex: 0 0 auto;
    width: 76px;
    height: 76px;
    object-fit: cover;
    border-radius: 8px;
    border: 1px solid #c8ccd1;
  }
  .row { display: flex; padding: 2px 0; }
  .gutter {
    flex: 0 0 26px;
    text-align: center;
    font-weight: 700;
    color: #72777d;
  }
  .text {
    flex: 1;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .add .text { background: #d8ecd8; }
  .add .gutter { color: #14866d; }
  .delete .text { background: #fbdfdf; text-decoration: line-through; }
  .delete .gutter { color: #d73333; }
  .context .text { color: #54595d; }
  ins { background: #a3d3ff; text-decoration: none; }
  del { background: #ffb3b3; }
  .gap .text, .footer .text { color: #72777d; text-align: center; }
</style>
</head>
<body>
<div id="diff">
<header>
<div class="heading">
<p class="eyebrow">Wikipedia edit</p>
<h1>${escapeHtml(page)}</h1>
${meta.description ? `<p class="description">${escapeHtml(meta.description)}</p>` : ''}
</div>
${meta.imageDataUri ? `<img class="thumb" src="${meta.imageDataUri}" alt="">` : ''}
</header>
${rows.join('\n')}
</div>
</body>
</html>`
}

module.exports = {
  parseDiffParams,
  fetchCompareDiff,
  fetchPageSummary,
  fetchImageAsDataUri,
  splitHighlights,
  summarizeDiff,
  buildAltText,
  renderDiffHtml
}
