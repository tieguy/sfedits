/**
 * Edit filter shape and predicates.
 *
 * Filters: { bots, minor, min_delta, cosmetic_only, substantive_only, substantive_channels }
 *
 * Polarity note: bots/minor are "allowed?" booleans (false = drop that class;
 * absent = allow). cosmetic_only is an opt-in switch (true = drop cosmetic-only
 * edits; absent/false = off). substantive_only is three-state: false (off, default) |
 * 'log' (classify + log, never drop) | true (enforce). This matches the design doc's
 * defaults, where the SF feeds set {bots: false, minor: false} and cosmetic_only is
 * opt-in.
 */

const DEFAULTS = { bots: true, minor: true, min_delta: 0, cosmetic_only: false, substantive_only: false, substantive_channels: null }

/**
 * Normalize filters to a canonical shape with defaults filled.
 */
function normalizeEditFilters(filters) {
  if (!filters || typeof filters !== 'object') return { ...DEFAULTS }
  // Coerce min_delta to a number first (handles "100" from JSON/DB as a string)
  const min_delta = Number(filters.min_delta)
  return {
    bots: filters.bots !== false,
    minor: filters.minor !== false,
    min_delta: Number.isFinite(min_delta) && min_delta > 0 ? min_delta : 0,
    cosmetic_only: filters.cosmetic_only === true,
    substantive_only: filters.substantive_only === true || filters.substantive_only === 'log'
      ? filters.substantive_only : false,
    substantive_channels: filters.substantive_channels && typeof filters.substantive_channels === 'object'
      ? filters.substantive_channels : null
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
 * Does this consumer need the two-revision significance check?
 * 'log' and true both need classification; only true enforces.
 */
function needsSignificanceCheck(filters) {
  return normalizeEditFilters(filters).substantive_only !== false
}

/**
 * Drop reason for a significance verdict, or null to keep the edit.
 * Conservative: missing verdict (classification failed upstream),
 * substantive verdicts, and fallback verdicts never drop; 'log' never drops.
 */
function significanceDropReason(verdict, filters) {
  const f = normalizeEditFilters(filters)
  if (f.substantive_only !== true) return null
  if (!verdict || verdict.substantive || verdict.fallback) return null
  return `substantive_only: ${(verdict.ignored || []).join(',') || 'no-change'}`
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
    // Strip structural/formatting tags (div, del, ins, span) but UNWRAP del/ins content (keep text)
    let text = cellContent
      .replace(/<\/?div[^>]*>/g, '')
      .replace(/<\/?span[^>]*>/g, '')
      .replace(/<\/?(?:del|ins)[^>]*>/g, '')  // unwrap del/ins, keeping text content
    // Decode HTML entities (including &nbsp;)
    text = text
      .replace(/&nbsp;/g, ' ')  // significant spaces encoded as &nbsp;
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

/**
 * Return the reason why an edit failed metadata filtering, or null if it passes.
 * Must mirror passesMetadata check order exactly to stay in sync.
 */
function metadataDropReason(edit, filters) {
  const f = normalizeEditFilters(filters)
  if (!f.bots && edit.robot) return 'bot'
  if (!f.minor && edit.minor) return 'minor'
  if (f.min_delta > 0 && edit.delta !== null && edit.delta !== undefined &&
      Math.abs(edit.delta) < f.min_delta) return 'min_delta'
  return null // edit passes all metadata checks
}

module.exports = { normalizeEditFilters, passesMetadata, needsContentCheck, needsSignificanceCheck, isCosmeticOnly, passesContent, metadataDropReason, significanceDropReason }
