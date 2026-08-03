/**
 * Edit filter shape and predicates.
 *
 * Filters: { bots, minor, min_delta, cosmetic_only }
 *
 * Polarity note: bots/minor are "allowed?" booleans (false = drop that class;
 * absent = allow). cosmetic_only is an opt-in switch (true = drop cosmetic-only
 * edits; absent/false = off). This matches the design doc's defaults, where the
 * SF feeds set {bots: false, minor: false} and cosmetic_only is opt-in.
 */

const DEFAULTS = { bots: true, minor: true, min_delta: 0, cosmetic_only: false }

/**
 * Normalize filters to a canonical shape with defaults filled.
 */
function normalizeEditFilters(filters) {
  if (!filters || typeof filters !== 'object') return { ...DEFAULTS }
  return {
    bots: filters.bots !== false,
    minor: filters.minor !== false,
    min_delta: Number.isFinite(filters.min_delta) && filters.min_delta > 0 ? filters.min_delta : 0,
    cosmetic_only: filters.cosmetic_only === true
  }
}

/**
 * Check if an edit passes metadata filters (fields from the stream).
 * Conservative bias: unknown/null delta is allowed.
 */
function passesMetadata(edit, filters) {
  const f = normalizeEditFilters(filters)
  if (!f.bots && edit.robot) return false
  if (!f.minor && edit.minor) return false
  if (f.min_delta > 0 && edit.delta !== null && edit.delta !== undefined &&
      Math.abs(edit.delta) < f.min_delta) return false
  return true
}

/**
 * Check if content (diff HTML) filtering is needed.
 */
function needsContentCheck(filters) {
  return normalizeEditFilters(filters).cosmetic_only
}

/**
 * Extract and classify changed lines from diff HTML.
 * Strips structural/formatting tags but keeps semantic tags (ref, etc).
 * Decodes entities and trims for classification.
 * Conservative bias: uncertain ⇒ NOT cosmetic.
 */
function isCosmeticOnly(html) {
  if (!html || typeof html !== 'string') return false

  // Extract diff-deletedline and diff-addedline cells
  const pattern = /<td[^>]*class="[^"]*diff-(?:deleted|added)line[^"]*"[^>]*>(.*?)<\/td>/gs
  let match
  const lines = []
  while ((match = pattern.exec(html)) !== null) {
    const cellContent = match[1]
    // Strip structural/formatting tags (div, del, ins, span) but keep semantic tags (ref, etc)
    let text = cellContent
      .replace(/<\/?div[^>]*>/g, '')
      .replace(/<\/?span[^>]*>/g, '')
      .replace(/<del[^>]*>.*?<\/del>/g, '')  // remove del content entirely
      .replace(/<ins[^>]*>(.*?)<\/ins>/g, '$1')  // keep ins content
    // Decode HTML entities
    text = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .trim()
    // Collect all lines, even empty ones (empty = cosmetic)
    lines.push(text)
  }

  // No lines extracted: NOT cosmetic (conservative bias)
  if (lines.length === 0) return false

  // Check if every extracted line is cosmetic
  return lines.every(line => isLineCosmetic(line))
}

/**
 * Classify a single line as cosmetic or not.
 * Cosmetic patterns:
 * - empty
 * - single non-nested template {{ }}
 * - category/file/image link
 * - <ref> tag
 */
function isLineCosmetic(line) {
  if (!line) return true // empty

  // Single non-nested template: {{...}} with no nested braces
  if (/^\{\{[^{}]*\}\}$/.test(line)) return true

  // Category, File, or Image link
  if (/^\[\[(Category|File|Image):[^\[\]]*\]\]$/i.test(line)) return true

  // Ref tag (self-closing or paired)
  if (/^<ref[^>]*\/>$/.test(line) || /^<ref[^>]*>.*<\/ref>$/s.test(line)) return true

  // Everything else is NOT cosmetic
  return false
}

/**
 * Check if diff HTML passes content filters.
 * With cosmetic_only absent/false, always passes without parsing.
 * With cosmetic_only: true, checks if the diff is cosmetic-only.
 */
function passesContent(html, filters) {
  const f = normalizeEditFilters(filters)
  if (!f.cosmetic_only) return true // No content filtering needed
  // cosmetic_only is enabled: drop if cosmetic-only
  return !isCosmeticOnly(html)
}

module.exports = { normalizeEditFilters, passesMetadata, needsContentCheck, isCosmeticOnly, passesContent }
