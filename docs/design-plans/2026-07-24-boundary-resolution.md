# Boundary Resolution & Fallback Design

## Summary

This project's geo-based article lookups depend on a place having a mapped
boundary polygon in OpenStreetMap. Today, if a place is missing that boundary —
as is common for informal neighborhoods — the lookup simply fails. This design
replaces that hard failure with a three-tier fallback: first try the place's own
boundary; if that's missing, walk upward through Wikidata's "located in" chain to
find the nearest containing place (like a city) that *does* have a boundary; and
if even that fails, fall back to a simple radius around the place's coordinates.
The tiers are ordered from most precise to least, and the system always tries the
cheaper, more accurate option before degrading.

The key design principle is "surface, don't silently substitute": when the
resolver has to reach for a containing region instead of the exact place, it
doesn't quietly swap in the substitute — it returns a suggestion and asks the
caller to confirm before fetching any articles. Only the last-resort radius
fallback proceeds automatically, since it stays centered on the place the user
actually asked about. The work is scoped tightly to a single new function
(`resolveBoundary`) and the one code path that currently fails; everything else in
the region-resolution system is untouched, and the design deliberately avoids
adding new data sources or dependencies to solve a problem that live data shows is
already rare.

## Definition of Done

The geo strategy no longer hard-fails when a place lacks an OpenStreetMap
boundary (P402). A new `resolveBoundary(qid)` in `lib/region.js` resolves a
boundary through three tiers — the place's own P402, the smallest boundaried
region that contains it (via the `P131` chain), or a spatial/radius fallback —
and `articlesForRegion`'s geo path consumes it. The behavior contract:

- **Exact self-boundary** → resolve and return articles exactly as today.
- **A containing region substitutes** → do **not** silently fetch articles;
  return a suggestion (`needsConfirmation`) so the caller can ask "no boundary
  for X — use Y?" Confirming Y re-resolves Y through the normal path.
- **No containing boundary** → proceed against a radius approximation of the
  requested place, flagged `approximate`, keeping the user on their region.

Verified by unit tests (nock'd WDQS) covering every tier and edge case, and by
live checks: the Mission District (Q7469) → container San Francisco (Q62); an
administrative place → its own boundary; a P402-less neighborhood with a
boundaried city parent → that container.

## Glossary

- **QID**: A unique identifier for an item in Wikidata (e.g. `Q7469` for the
  Mission District), always starting with "Q".
- **P402**: The Wikidata property linking a place to its corresponding
  OpenStreetMap relation — i.e., whether a boundary polygon exists for it at all.
- **P131**: The Wikidata property meaning "located in the administrative
  territorial entity" — the link from a place to its containing region (e.g., a
  neighborhood to its city). Places can have multiple P131 parents, and rare
  cycles exist.
- **WDQS**: Wikidata Query Service, the SPARQL endpoint used to query Wikidata's
  graph (e.g., for P402/P131 lookups).
- **SPARQL**: The query language used to ask WDQS questions like "does this place
  have a boundary?" or "what contains this place?"
- **Overpass (API)**: A separate query service (not WDQS) used to fetch the
  actual OSM boundary polygon once an OSM relation ID is known.
- **OSM relation**: An OpenStreetMap object type used to represent an area's
  boundary (e.g., relation `111968` for San Francisco); this is what P402 points to.
- **`wikibase:around`**: A WDQS/SPARQL geo-search clause that finds items within a
  radius of a point — used here as the "nearby" tier's candidate search.
- **Point-in-polygon**: A geometric test for whether a coordinate falls inside a
  given polygon; used here (via the `@turf/boolean-point-in-polygon` library) to
  confirm a "nearby" candidate's boundary actually contains the requested place.
- **Centroid**: The geometric center point of a place, used as the anchor for the
  radius fallback when no polygon is available.
- **`needsConfirmation`**: A flag this design introduces on the result object to
  signal that the resolver substituted a containing region and is waiting for the
  caller to confirm before proceeding.
- **`approximate`**: A flag this design introduces to mark results that used the
  radius fallback (no exact boundary), so callers/UI can indicate reduced precision.
- **YAGNI** ("You Aren't Gonna Need It"): A design principle cited to justify not
  building additional resolution sources (e.g., OSM-name lookups, government
  open-data adapters) since current data shows they aren't needed yet.

## Architecture

When a requested place lacks its own boundary, the resolver finds the nearest
boundaried region rather than failing. This is viable because Wikidata P402
coverage, measured live 2026-07-24, is high for administrative places (US
cities 98.8%, French communes 83.7%, English civil parishes 76.4%) and the
only sparse tier is informal neighborhoods (7.2%) — and even there, **84.7% of
P402-less neighborhoods have a *direct* P131 container that carries P402**, and
that container is city/municipality scale (never state or country). So a
containment fallback almost always lands on a real, reasonably-scoped boundary.

**`resolveBoundary` contract** (new, in `lib/region.js`):

```
resolveBoundary(qid) → Promise<BoundaryResolution>

BoundaryResolution =
  | { source: 'self',      exact: true,  boundary: Feature }
  | { source: 'container', exact: false, suggestion: { qid, label, class, via: 'p131' } }
  | { source: 'nearby',    exact: false, suggestion: { qid, label, class, via: 'around' } }
  | { source: 'radius',    exact: false, centroid: { lon, lat } }
```

Resolution tiers, in order:

1. **Self** — the place has P402: fetch its polygon via `fetchBoundary`
   (`lib/osm-boundary.js`) → `{ source:'self', exact:true, boundary }`.
2. **Container** — walk `P131` **upward level-by-level** (breadth-first),
   testing P402 at each level, stopping at the first level with a hit (the
   *smallest* boundaried container). Guards: a `visited` set (P131 has
   multi-parents and rare cycles) and a depth cap (~5). Multiple hits at one
   level → pick smallest by area. Returns the container identity only; the
   boundary is not fetched here.
3. **Nearby / radius** — no boundaried ancestor: `wikibase:around` for the
   nearest boundaried region whose polygon **contains the place's point**
   (point-in-polygon via the already-imported `@turf/boolean-point-in-polygon`).
   If none, return `{ source:'radius', centroid }` and let the caller seed a
   radius with no polygon filter.

**Why a level-walk, not one `P131+` property-path query:** a property path
returns *all* boundaried ancestors (city, county, state, country) with no cheap
notion of "closest." The level-walk returns the nearest deterministically, in
1–2 cheap queries for the common case.

**"Usable boundary" is P402-only.** No OSM-name lookup or per-city government
open-data adapters in this pass (YAGNI): P402 already covers containers ~99% of
the time, and the radius tier catches the remainder. Gov-data adapters remain a
future pool-enrichment lever if neighborhood *precision* ever becomes a goal.

**Integration is localized to the geo path.** `resolveRegion` and the admin
path are untouched. In `articlesForRegion`, the geo branch's current
`throw "needs OSM boundary (P402)"` is replaced by a `resolveBoundary` call:
`self` → today's behavior; `container`/`nearby` → return
`{ region, suggestion, needsConfirmation:true }` without fetching articles;
`radius` → `articlesByGeo` with the existing radius seed, no polygon filter,
result flagged `approximate:true`. "Surface, don't silently substitute" applies
to the container/nearby cases; radius stays on the requested place.

## Existing Patterns

Investigation of the `place-bot-platform` worktree found the resolver already
structured around these components in `lib/region.js`:

- `resolveRegion(qid)` → `{ qid, label, classes, strategy, osmRelationId,
  centroid }`, choosing admin vs. geo by class.
- `articlesForRegion(qid, options)` → dispatches to `articlesByAdmin` or, for
  geo, fetches a boundary and calls `articlesByGeo`. This is where the P402
  hard-fail lives today.
- `articlesByGeo(region, { boundary, radiusKm })` — radius seed around the
  centroid, then a point-in-polygon filter against the boundary. Its radius
  seed is reused directly by the `radius` tier.
- `fetchBoundary(osmRelationId)` in `lib/osm-boundary.js` — Overpass fetch +
  ring stitching. Reused unchanged by the `self` tier.
- `@turf/boolean-point-in-polygon` is already imported in `lib/region.js`.

Shared WDQS access is in `lib/sparql.js` (`sparqlRows`, `sparqlSelect`,
`SPARQL_URL`); the P131 level-walk and `wikibase:around` queries follow the same
single-query, timeout-aware pattern established by the recent unchunked-query +
size-guard work (`runRegionQuery`, `isTimeout`). Tests use mocha/chai with nock
intercepting global fetch, matching `test/region.test.js`. This design adds no
new runtime dependencies.

## Implementation Phases

### Phase 1: resolveBoundary — self + container tiers
**Goal:** Resolve a boundary from the place's own P402, or the smallest
boundaried P131 container.

**Components:**
- `resolveBoundary` in `lib/region.js` — tier 1 (self P402 → `fetchBoundary`)
  and tier 2 (breadth-first `P131` walk to the nearest P402-bearing ancestor,
  with `visited` set, depth cap, and smallest-by-area tiebreak). Returns the
  `self`/`container` variants of `BoundaryResolution`.
- A small P131-level query helper alongside the existing SPARQL helpers.
- Unit tests in `test/region.test.js`.

**Dependencies:** None beyond current `lib/region.js` / `lib/sparql.js`.

**Done when:** Unit tests pass for: self-P402; container one level up; container
that skips an unbounded intermediate parent; multiple bounded parents at a level
→ smallest by area; cycle/multi-parent guard; depth cap exhausted with no hit
(falls through to tier 3, stubbed here).

### Phase 2: resolveBoundary — nearby + radius tier
**Goal:** Handle places with no boundaried ancestor.

**Components:**
- Tier 3 in `resolveBoundary`: `wikibase:around` candidate query filtered to
  boundaried regions, point-in-polygon containment test of the place's centroid
  (`@turf/boolean-point-in-polygon`), else a `radius` result carrying the
  centroid.
- Unit tests in `test/region.test.js`.

**Dependencies:** Phase 1.

**Done when:** Unit tests pass for: `around` returns a containing boundaried
region (`nearby`); `around` returns only non-containing candidates → `radius`;
`around` empty → `radius`; place with no centroid → clear error.

### Phase 3: Geo-path integration + suggestion contract + live verification
**Goal:** Route the geo strategy through `resolveBoundary` and surface
suggestions instead of hard-failing.

**Components:**
- `articlesForRegion` geo branch in `lib/region.js`: replace the P402 throw with
  `resolveBoundary`; `self` → existing `articlesByGeo` path; `container`/`nearby`
  → `{ region, suggestion, needsConfirmation:true }` (no article fetch);
  `radius` → `articlesByGeo` radius seed, `approximate:true`.
- Integration tests in `test/region.test.js` for each branch.

**Dependencies:** Phases 1–2.

**Done when:** Integration tests pass for exact / container(needsConfirmation) /
radius. Live checks confirm: Mission District (Q7469) → container San Francisco
(Q62, OSM relation 111968); an administrative place → `self`; a P402-less
neighborhood with a boundaried city parent → `container`.

## Additional Considerations

**Error handling:** WDQS timeouts in `resolveBoundary` reuse the existing
`isTimeout` translation; Overpass fetches inherit `fetchBoundary`'s existing
handling (Overpass mirrors were observed flaky during design — the `self`/`nearby`
tiers should tolerate a boundary-fetch failure by degrading to `radius` rather
than throwing).

**Edge cases:** `P131` multi-parents and cycles are handled by the `visited`
set and depth cap. A place lacking both P402 and a centroid cannot use any tier
and returns a clear error.

**Future extensibility:** The `suggestion.via` field distinguishes how a
container was found (`p131` vs `around`), leaving room for additional resolution
sources (OSM-name lookup, municipal open-data adapters) without changing the
contract. These are deliberately out of scope now.
