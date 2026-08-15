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
  'template-bag': 'ignored',
  links: 'ignored',
  categories: 'ignored',
  'external-links': 'ignored'
}

// Inputs above this size skip parsing entirely and conservative-pass.
// ~1.5MB is several times the largest article on the current watchlist;
// two concurrent parses of pathological pages are an OOM risk (LUI-120).
const MAX_INPUT_CHARS = 1.5 * 1024 * 1024

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

function extractChannels(doc) {
  const sortedJson = list => list.map(stableStringify).sort().join('\n')
  // orderedJson preserves document order (unlike sortedJson), used for structures
  // where reader-visible order matters (e.g., table sequence in a document).
  const orderedJson = list => list.map(stableStringify).join('\n')
  const internalLinks = doc.links().filter(l => l.type() === 'internal')
  const externalLinks = doc.links().filter(l => l.type() === 'external')
  return {
    prose: doc.text().replace(/\s+/g, ' ').trim(),
    'infobox-values': stableStringify(doc.infoboxes().map(i => stripLinks(i.json()))),
    references: sortedJson(doc.references().map(r => r.json())),
    media: sortedJson(doc.images().map(i => ({ file: i.file(), caption: i.caption(), alt: i.alt() }))),
    tables: orderedJson(doc.tables().map(t => stripLinks(t.json()))),
    // Heading order is meaningful to a reader, so no sort here.
    headings: doc.sections().map(s => s.title()).filter(Boolean).join('\n'),
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
  } catch (err) {
    return { substantive: true, reasons: [], ignored: [], fallback: 'parse-error', error: err.message }
  }
  const reasons = []
  const ignored = []
  for (const name of Object.keys(before)) {
    if (before[name] === after[name]) continue
    if (policy[name] === 'substantive') reasons.push(name)
    else ignored.push(name)
  }
  return { substantive: reasons.length > 0, reasons, ignored }
}

module.exports = { classifyEdit, extractChannels, DEFAULT_CHANNELS, MAX_INPUT_CHARS }
