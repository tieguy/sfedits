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

module.exports = { normalizeEditFilters, passesMetadata, needsContentCheck }
