/**
 * Substantive-edit classifier: does an edit change what a reader sees?
 *
 * Pure module — two wikitexts in, verdict out. No network, no config files,
 * no delivery knowledge (that separation keeps a later extraction to a
 * standalone package a file move). Design:
 * docs/design-plans/2026-08-14-substantive-edit-filter.md
 *
 * A "channel" is a named slice of the wtf_wikipedia parse, compared across
 * the two revisions. Channel policy decides which changes count:
 * 'substantive' channels decide the verdict; 'ignored' channels are
 * reported but never decide. Whitespace differences never count: prose is
 * whitespace-normalized and every other channel compares parsed structures.
 *
 * Channels that extract nested wikitext (tables, infobox-values) compare
 * rendered text only: embedded link targets are stripped before comparison,
 * because a link retarget with unchanged display text is not reader-visible
 * and falls under the 'links' policy ('ignored').
 */
const wtf = require('wtf_wikipedia')

const DEFAULT_CHANNELS = {
  prose: 'substantive',
  'infobox-values': 'substantive',
  references: 'substantive',
  media: 'substantive',
  tables: 'substantive',
  headings: 'substantive',
  redirect: 'substantive',
  'template-bag': 'ignored',
  links: 'ignored',
  categories: 'ignored',
  'external-links': 'ignored'
}

// Inputs above this size skip parsing entirely and conservative-pass (the
// edit still delivers, unclassified). 800KB is sized from measured data
// (2026-08-15): the largest article on all of English Wikipedia is 772KB
// (Wiki Replicas, 7.2M mainspace pages), the largest revision in the three
// validation cohorts is 507KB, and MediaWiki's hard cap is 2048KB. Kept
// deliberately tight because parses are synchronous and memory-heavy and
// the host runs multiple services (LUI-120 OOM history).
const MAX_INPUT_CHARS = 800 * 1024

// Recursively remove the 'links' metadata key from an object tree. Used to strip
// embedded link metadata from table cells and infobox values before comparison,
// since a link retarget with unchanged rendered text is not reader-visible.
// Only strips 'links' when the SAME object carries a rendered-text field,
// to avoid deleting a real parameter or column header literally named 'links'.
function stripLinks(obj) {
  if (Array.isArray(obj)) return obj.map(stripLinks)
  if (obj && typeof obj === 'object') {
    const result = {}
    for (const [key, value] of Object.entries(obj)) {
      // Only strip 'links' metadata when this object also has rendered text
      if (key === 'links' && typeof obj.text === 'string') continue
      result[key] = stripLinks(value)
    }
    return result
  }
  return obj
}

// JSON.stringify with sorted object keys, so key order never reads as a change.
function stableStringify(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}'
  }
  return JSON.stringify(value)
}

// Canonicalize wikitext for raw-wikitext comparison by removing formatting noise.
// Used for table and reference raw-wikitext augmentation to ensure the "whitespace
// differences never count" promise holds: we compare the prose content and structure,
// not the markup layout. Returns a canonical form insensitive to:
// - Cell/header separator layout: || and !! can be on the same line or separate rows
// - All other whitespace (tabs, newlines, trailing spaces)
// - Link targets (keeps display text, strips retargets)
// - Table/ref/cell attributes (class=, style=, align=, cell prefixes, ref name=, etc.)
// - Template parameter order (params sorted within each template)
function canonicalizeWikitext(text) {
  let result = text

  // Normalize cell/header separators to newlines FIRST, before attribute stripping.
  // This makes "| A || B" (one line) and "| A\n| B" (separate rows) equivalent.
  // Converting || to \n| and !! to \n! ensures each cell gets its own logical line.
  result = result.replace(/\|\|/g, '\n|') // || inline cell separator → newline + |
  result = result.replace(/!!/g, '\n!') // !! inline header separator → newline + !

  // Strip link targets, keep display text. Internal links: [[target|display]]
  // → display, [[target]] → target. External links: [proto://url display] →
  // display. A retarget with unchanged display text is not reader-visible;
  // the links / external-links channels report those changes.
  result = result
    .replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2') // [[target|display]] → display
    .replace(/\[\[([^\]]+)\]\]/g, '$1') // [[target]] → target
    .replace(/\[(?:https?:|\/\/)\S+\s+([^\]]*)\]/g, '$1') // [url display] → display

  // Strip table attributes: {| class="..." → {| (attributes are on the opening line only)
  result = result.replace(/\{\|[^\n]*/g, '{|')

  // Strip row-separator attributes: |- class="odd" → |-
  result = result.replace(/^\s*\|-[^\n]*/gm, '|-')

  // Strip table cell/header attributes: | attr=val | content → | content
  // The [^|!\n]* ensures we stop at a cell/header marker, not consuming content
  result = result.replace(/^\s*\|[^|!\n]*\|/gm, '|')
  result = result.replace(/^\s*![^!|\n]*\|/gm, '!')

  // Strip ref attributes: <ref name="x"> → <ref>, <ref group="..." > → <ref>
  result = result.replace(/<ref[^>]*>/g, '<ref>')

  // Sort NAMED template parameters within each {{...}} template so their
  // source order never reads as a change. Positional parameters keep their
  // order — it is semantic ({{Cita|Madrid|Barcelona}} differs from the
  // reverse). Known limitation: the regex does not handle templates nested
  // inside parameter values; those canonicalize deterministically but not
  // minimally, which errs toward reporting a change, never hiding one.
  // The inner class excludes | as well as } — with [^}]* alone the quantifier
  // is ambiguous (each segment could swallow pipes), and a stray {{ with no
  // closing braces makes the failed match backtrack exponentially: ~50 pipes
  // of following table text hang the event loop for minutes.
  result = result.replace(/\{\{([^|]*)((?:\|[^|}]*)*)\}\}/g, (match, name, params) => {
    if (!params) return match // No parameters
    const paramList = params.split('|').slice(1) // Skip the first empty split
    const named = paramList.filter(p => p.includes('='))
    const positional = paramList.filter(p => !p.includes('='))
    named.sort()
    return '{{' + name + '|' + positional.concat(named).join('|') + '}}'
  })

  // Remove all whitespace: spaces, tabs, newlines, etc.
  result = result.replace(/\s+/g, '')

  return result
}

// Count ref invocation markers in RAW wikitext (<ref ...> and <ref ... />).
// Runs on the raw revision text, not the parse: wtf's serialization drops
// self-closing named-ref reuses, and a reuse is a visible footnote marker.
function countRefMarkers(text) {
  const m = text.match(/<ref[\s>\/]/gi)
  return m ? m.length : 0
}

function extractChannels(doc) {
  const sortedJson = list => list.map(stableStringify).sort().join('\n')
  // orderedJson preserves document order (unlike sortedJson), used for structures
  // where reader-visible order matters (e.g., table sequence in a document).
  const orderedJson = list => list.map(stableStringify).join('\n')
  const internalLinks = doc.links().filter(l => l.type() === 'internal')
  const externalLinks = doc.links().filter(l => l.type() === 'external')

  // References: compare wtf's json AND the canonicalized wikitext. The json
  // alone misses citation templates that parse to empty json (every Spanish
  // Cita-family template) and free text sitting beside a template inside the
  // ref, which renders in the footnote. Canonicalization keeps formatting,
  // attribute, and named-parameter-order changes invisible.
  const refExtractor = doc.references().map(r => {
    const json = r.json()
    return { json, wikitext: canonicalizeWikitext(r.wikitext()) }
  })

  // Tables: include canonicalized wikitext alongside JSON to capture captions and
  // references to header cells that wtf's .json() method loses. Plain mid-table
  // headers come through the JSON rows. Canonicalization removes formatting-only
  // differences (whitespace, cell separator layout, attributes).
  const tableExtractor = doc.tables().map(t => {
    const json = stripLinks(t.json())
    const wikitextCanon = canonicalizeWikitext(t.wikitext())
    return { json, wikitext: wikitextCanon }
  })

  // Redirect: extract the target (page + anchor) if this is a redirect page.
  // The anchor is semantically significant: a retarget to a different anchor
  // is a reader-visible change even if the page name stays the same.
  let redirectTarget = ''
  if (doc.isRedirect && doc.isRedirect()) {
    const redirectInfo = doc.redirectTo()
    if (redirectInfo && redirectInfo.page) {
      redirectTarget = redirectInfo.page
      if (redirectInfo.anchor) {
        redirectTarget += '#' + redirectInfo.anchor
      }
    }
  }

  return {
    prose: doc.text().replace(/\s+/g, ' ').trim(),
    'infobox-values': stableStringify(doc.infoboxes().map(i => stripLinks(i.json()))),
    references: sortedJson(refExtractor),
    media: sortedJson(doc.images().map(i => ({ file: i.file(), caption: i.caption(), alt: i.alt() }))),
    tables: orderedJson(tableExtractor),
    // Heading order is meaningful to a reader, so no sort here.
    // Depth is part of the heading: a level change (== -> ===) moves the
    // section in the visible hierarchy and the TOC. Order is preserved
    // (reader-visible), matching the tables channel's rationale.
    headings: doc.sections().filter(s => s.title()).map(s => s.indentation() + ':' + s.title()).join('\n'),
    redirect: redirectTarget,
    'template-bag': sortedJson(doc.templates().map(t => t.json())),
    links: [...new Set(internalLinks.map(l => l.page()).filter(Boolean))].sort().join('\n'),
    categories: doc.categories().slice().sort().join('\n'),
    'external-links': [...new Set(externalLinks.map(l => l.site()).filter(Boolean))].sort().join('\n')
  }
}

/**
 * Classify one edit.
 * @param {string} prevWikitext  parent revision wikitext
 * @param {string} currWikitext  new revision wikitext
 * @param {object} [opts]
 * @param {object} [opts.channels]  per-channel policy overrides
 *   ({channelName: 'substantive'|'ignored'}), merged over DEFAULT_CHANNELS
 * @param {string} [opts.lang]  reserved for language-specific behavior;
 *   wtf_wikipedia's alias tables are multilingual, so parsing needs no flag
 * @returns {{substantive: boolean, reasons: string[], ignored: string[], fallback?: string, error?: string}}
 *   fallback is set when classification could not run; callers must treat
 *   fallback verdicts as substantive (conservative pass), and they already
 *   are (substantive: true). error is set when fallback is 'parse-error'
 *   to help offline validation diagnose failures.
 */
function classifyEdit(prevWikitext, currWikitext, { channels, lang = 'en' } = {}) {
  void lang
  const policy = { ...DEFAULT_CHANNELS, ...(channels || {}) }
  const prev = typeof prevWikitext === 'string' ? prevWikitext : ''
  const curr = typeof currWikitext === 'string' ? currWikitext : ''
  if (!prev || !curr) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'missing-content' }
  }
  if (prev.length > MAX_INPUT_CHARS || curr.length > MAX_INPUT_CHARS) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'input-too-large' }
  }
  // Sequential parses on purpose: parsing both concurrently doubles peak
  // memory on large articles. A parse/extraction throw is a fallback, not an
  // exception: the module must honor conservative-pass for ANY caller.
  let before, after
  try {
    before = extractChannels(wtf(prev))
    after = extractChannels(wtf(curr))
    // The marker count is part of the references channel: a named-ref reuse
    // adds or removes a visible footnote marker without changing the
    // citation list, and only the raw text still contains it.
    before.references = countRefMarkers(prev) + '\n' + before.references
    after.references = countRefMarkers(curr) + '\n' + after.references
  } catch (err) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'parse-error', error: err.message }
  }
  const reasons = []
  const ignored = []
  for (const name of Object.keys(before)) {
    if (before[name] === after[name]) continue
    // Only an explicit 'ignored' policy suppresses a changed channel. Any
    // other value — including a misspelled override — counts as substantive,
    // so a bad policy can only over-deliver, never silently drop edits.
    if (policy[name] === 'ignored') ignored.push(name)
    else reasons.push(name)
  }
  return { substantive: reasons.length > 0, reasons, ignored }
}

module.exports = { classifyEdit, extractChannels, DEFAULT_CHANNELS, MAX_INPUT_CHARS }
