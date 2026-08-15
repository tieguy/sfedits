const { assert } = require('chai')

const {
  percentileRanks, median, leadScore, scoreCohort, pickCandidates, BAY_AREA_RE,
  wikitextLinks, canonicalInlinks, redirectTargets, buildUniverse, assignTiers
} = require('../scripts/reassess')

describe('reassess', function() {

  describe('percentileRanks', function() {
    it('ranks distinct values 0..1', function() {
      assert.deepEqual(percentileRanks([10, 30, 20]), [0, 1, 0.5])
    })

    it('averages tied ranks', function() {
      // two zeros share ranks 0 and 1 -> average 0.5 -> 0.5/3
      const ranks = percentileRanks([0, 0, 5, 9])
      assert.approximately(ranks[0], 0.5 / 3, 1e-9)
      assert.approximately(ranks[1], 0.5 / 3, 1e-9)
      assert.equal(ranks[3], 1)
    })

    it('handles a single value', function() {
      assert.deepEqual(percentileRanks([42]), [0.5])
    })
  })

  describe('median', function() {
    it('odd length', function() { assert.equal(median([3, 1, 2]), 2) })
    it('even length averages the middle two', function() {
      assert.equal(median([1, 2, 3, 10]), 2.5)
    })
  })

  describe('leadScore', function() {
    it('scores an early mention near 1', function() {
      const { score, term } = leadScore('San Francisco is a city in California.')
      assert.equal(term, 'San Francisco')
      assert.isAbove(score, 0.95)
    })

    it('scores a late mention lower than an early one', function() {
      const early = leadScore('Oakland something something else entirely here.')
      const late = leadScore('Something something else entirely here Oakland.')
      assert.isAbove(early.score, late.score)
    })

    it('returns 0 with no mention', function() {
      assert.deepEqual(leadScore('Netscape was a browser company.'),
        { score: 0, term: null })
      assert.deepEqual(leadScore(''), { score: 0, term: null })
    })

    it('does not match ambiguous bare city names', function() {
      assert.isNull(BAY_AREA_RE.exec('Richmond and Santa Rosa are ambiguous.'))
    })
  })

  describe('wikitextLinks', function() {
    it('extracts plain and piped links', function() {
      const links = wikitextLinks('The [[Mission District]] and [[Bay Bridge|the bridge]].')
      assert.deepEqual([...links].sort(), ['Bay Bridge', 'Mission District'])
    })

    it('strips section anchors', function() {
      assert.deepEqual([...wikitextLinks('[[Oakland#History]]')], ['Oakland'])
    })

    it('normalizes underscores and leading case like MediaWiki', function() {
      assert.deepEqual([...wikitextLinks('[[san_francisco bay]]')], ['San francisco bay'])
    })

    it('counts a repeated link once', function() {
      assert.deepEqual([...wikitextLinks('[[Caltrain]] runs. See [[Caltrain]].')], ['Caltrain'])
    })

    it('ignores links inside HTML comments', function() {
      assert.deepEqual([...wikitextLinks('[[Berkeley]] <!-- [[Hidden Place]] -->')], ['Berkeley'])
    })

    it('excludes file, image and category links', function() {
      const links = wikitextLinks('[[File:X.jpg|thumb]] [[Category:Y]] [[Image:Z.png]] [[Alcatraz]]')
      assert.deepEqual([...links], ['Alcatraz'])
    })

    it('does not return links from inside image captions', function() {
      // Known difference from the previous regex implementation, accepted when
      // switching to wtf_wikipedia: its caption() strips links, so they are not
      // recoverable. Measured at roughly one link per article - Coit Tower lost
      // only "San Francisco Giants". Worth it for what the parser fixes below.
      const links = wikitextLinks('[[File:X.jpg|thumb|A view of [[Coit Tower]]]]')
      assert.deepEqual([...links], [])
    })

    it('keeps a simple infobox field that names a place', function() {
      // `location`/`headquarters`/`borough` are exactly the claim the metric wants
      const links = wikitextLinks(
        '{{Infobox station\n| borough = [[Oakland, California|Oakland]]\n}}')
      assert.deepEqual([...links], ['Oakland, California'])
    })

    it('drops infobox fields that are specification lists', function() {
      // {{hlist}}/{{Ubl}} inside an infobox enumerate values; they are not an
      // editorial claim that the two subjects are related. 33 of Instagram's
      // links were languages from one such field.
      const links = wikitextLinks(
        '{{Infobox software\n| operating system = {{hlist|[[iOS]]|[[Android (operating system)|Android]]}}\n}}')
      assert.deepEqual([...links], [])
    })

    it('excludes interwiki targets', function() {
      // the parser returns ":wikt:abstract" alongside real titles
      const links = wikitextLinks('See [[:wikt:abstract]] and [[Alcatraz]].')
      assert.deepEqual([...links], ['Alcatraz'])
    })

    it('does NOT see links that only a transcluded template would render', function() {
      // the whole point of the stage: a navbox call contributes no links here
      assert.deepEqual([...wikitextLinks('Text. {{Bay Area Rapid Transit}}')], [])
    })

    it('returns an empty set for empty or missing text', function() {
      assert.equal(wikitextLinks('').size, 0)
      assert.equal(wikitextLinks(undefined).size, 0)
    })

    it('ignores publications wikilinked inside a citation template', function() {
      // ~93% of TechCrunch's inbound links are of this shape: a reference, not
      // a statement that the article is about TechCrunch.
      const links = wikitextLinks(
        'Instagram launched.<ref>{{cite web |work=[[TechCrunch]] |title=X}}</ref> ' +
        'It is based in [[Menlo Park]].')
      assert.deepEqual([...links], ['Menlo Park'])
    })

    it('ignores links anywhere inside ref tags, not just citation templates', function() {
      const links = wikitextLinks(
        'Text.<ref>See [[Oakland Tribune]], p. 4.</ref> More [[Berkeley]] text.')
      assert.deepEqual([...links], ['Berkeley'])
    })

    it('handles self-closing and named ref tags', function() {
      const links = wikitextLinks(
        '[[Alcatraz]] text.<ref name="a">[[Wired (magazine)]]</ref><ref name="a" /> end.')
      assert.deepEqual([...links], ['Alcatraz'])
    })

    it('ignores a bare citation template outside ref tags', function() {
      const links = wikitextLinks('{{cite news |work=[[San Francisco Chronicle]]}} [[Presidio]]')
      assert.deepEqual([...links], ['Presidio'])
    })

    it('still counts a publication linked in actual prose', function() {
      const links = wikitextLinks('The [[San Francisco Chronicle]] is the city\'s daily paper.')
      assert.deepEqual([...links], ['San Francisco Chronicle'])
    })
  })

  describe('canonicalInlinks', function() {
    const cohort = ['California gold rush', 'Netflix']
    const redirects = {
      'California gold rush': 'California gold rush',
      'California Gold Rush': 'California gold rush',
      'Gold Rush (California)': 'California gold rush',
      Netflix: 'Netflix'
    }

    it('folds redirect counts into the canonical title', function() {
      const counts = { 'California gold rush': 60, 'California Gold Rush': 250, 'Gold Rush (California)': 35 }
      const out = canonicalInlinks(counts, redirects, cohort)
      assert.equal(out['California gold rush'], 345)
    })

    it('leaves an article with no redirects unchanged', function() {
      const out = canonicalInlinks({ Netflix: 125 }, redirects, cohort)
      assert.equal(out.Netflix, 125)
    })

    it('drops targets outside the cohort', function() {
      const out = canonicalInlinks({ Netflix: 125, Microsoft: 177 }, redirects, cohort)
      assert.isUndefined(out.Microsoft)
    })

    it('ignores targets absent from the redirect map', function() {
      // unmapped titles cannot be resolved and must not be guessed at
      const out = canonicalInlinks({ 'Some Unmapped Title': 9 }, redirects, cohort)
      assert.isUndefined(out['Some Unmapped Title'])
    })

    it('reports zero for a cohort article nothing links to', function() {
      const out = canonicalInlinks({ Netflix: 3 }, redirects, cohort)
      assert.equal(out['California gold rush'], 0)
    })
  })

  describe('redirectTargets', function() {
    const cohort = [{ title: 'Oakland' }, { title: 'Berkeley' }]

    it('returns cohort titles when there are no candidates', function() {
      assert.deepEqual(redirectTargets(cohort, null), ['Oakland', 'Berkeley'])
    })

    it('includes untagged candidates so their inlinks are not undercounted', function() {
      const out = redirectTargets(cohort, [{ title: 'Port of Oakland' }])
      assert.include(out, 'Port of Oakland')
      assert.lengthOf(out, 3)
    })

    it('de-duplicates a candidate that is also in the cohort', function() {
      const out = redirectTargets(cohort, [{ title: 'Oakland' }, { title: 'Sausalito' }])
      assert.lengthOf(out, 3)
      assert.equal(out.filter(t => t === 'Oakland').length, 1)
    })
  })

  describe('buildUniverse', function() {
    const cohort = [
      { title: 'Oakland, California', importance: 'top' },
      { title: 'Some List', importance: 'na' }
    ]
    const candidates = [
      { title: 'Port of Oakland', via: ['P159'] },
      { title: 'Microsoft', via: ['P937'] },
      { title: 'Joe DiMaggio', via: ['P19', 'P20'] },
      { title: 'Plaza de César Chávez', via: ['P131'] },
      { title: 'Chyanne Chen', via: ['P39'] }
    ]

    it('keeps candidates whose Wikidata says the subject IS in the region', function() {
      const titles = buildUniverse(cohort, candidates).map(u => u.title)
      assert.include(titles, 'Port of Oakland')
      assert.include(titles, 'Plaza de César Chávez')
      assert.include(titles, 'Chyanne Chen')
    })

    it('drops candidates that merely passed through - born, died, worked', function() {
      const titles = buildUniverse(cohort, candidates).map(u => u.title)
      assert.notInclude(titles, 'Microsoft', 'work location only')
      assert.notInclude(titles, 'Joe DiMaggio', 'birth and death only')
    })

    it('excludes NA-class cohort entries but keeps rated ones', function() {
      const titles = buildUniverse(cohort, candidates).map(u => u.title)
      assert.include(titles, 'Oakland, California')
      assert.notInclude(titles, 'Some List')
    })

    it('marks which entries are already tagged', function() {
      const u = Object.fromEntries(buildUniverse(cohort, candidates).map(x => [x.title, x]))
      assert.isTrue(u['Oakland, California'].tagged)
      assert.equal(u['Oakland, California'].importance, 'top')
      assert.isFalse(u['Port of Oakland'].tagged)
      assert.isNull(u['Port of Oakland'].importance)
    })

    it('does not duplicate a candidate that is already tagged', function() {
      const out = buildUniverse(cohort, [...candidates, { title: 'Oakland, California', via: ['P131'] }])
      assert.equal(out.filter(x => x.title === 'Oakland, California').length, 1)
      assert.isTrue(out.find(x => x.title === 'Oakland, California').tagged)
    })

    it('shares the is-here property set with lib/region, not a copy', function() {
      // The universe rule and the place-bot membership rule are one decision.
      // strictEqual proves both consumers hold the SAME array, so they cannot
      // drift apart the way two hand-maintained copies would.
      const { IS_HERE_PROPERTIES: fromScript } = require('../scripts/reassess')
      const { IS_HERE_PROPERTIES: fromLib } = require('../lib/region')
      assert.strictEqual(fromScript, fromLib)
    })
  })

  describe('assignTiers', function() {
    // 1000 articles, descending score
    const ranked = Array.from({ length: 1000 }, (_, i) => ({ title: `A${i}`, inlinks: 1000 - i }))

    it('cuts tiers at the given percentiles of the ranked list', function() {
      const out = assignTiers(ranked, { top: 0.0025, high: 0.025, mid: 0.15 })
      assert.equal(out.filter(r => r.tier === 'top').length, 3)
      assert.equal(out.filter(r => r.tier === 'high').length, 22)
      assert.equal(out.filter(r => r.tier === 'mid').length, 125)
      assert.equal(out.filter(r => r.tier === 'low').length, 850)
    })

    it('assigns the highest-ranked article to top', function() {
      const out = assignTiers(ranked, { top: 0.0025, high: 0.025, mid: 0.15 })
      assert.equal(out[0].tier, 'top')
      assert.equal(out[out.length - 1].tier, 'low')
    })

    it('records the inlink cutoff for each tier', function() {
      const out = assignTiers(ranked, { top: 0.0025, high: 0.025, mid: 0.15 })
      assert.equal(out.cutoffs.top, 998)
      assert.equal(out.cutoffs.high, 976)
    })
  })

  describe('scoreCohort', function() {
    const inputs = {
      cohort: [
        { title: 'SF Board of Supervisors', importance: 'high' },
        { title: 'Netscape', importance: 'high' },
        { title: 'Daniel Lurie', importance: 'low' }
      ],
      qids: { 'SF Board of Supervisors': 'Q1', Netscape: 'Q2', 'Daniel Lurie': 'Q3' },
      links: { 'SF Board of Supervisors': 40, Netscape: 2, 'Daniel Lurie': 25 },
      claims: { Q1: 5, Q2: 1, Q3: 4 },
      assessments: {
        'SF Board of Supervisors': { otherProjects: 1 },
        Netscape: { otherProjects: 8 },
        'Daniel Lurie': { otherProjects: 2 }
      },
      leads: {
        'SF Board of Supervisors': { score: 0.9, term: 'San Francisco' },
        Netscape: { score: 0 },
        'Daniel Lurie': { score: 0.8, term: 'San Francisco' }
      }
    }

    it('gives SF-central articles higher significance than incidental ones', function() {
      const rows = scoreCohort(inputs)
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      assert.isAbove(byTitle['SF Board of Supervisors'].significance,
        byTitle['Netscape'].significance)
      assert.isAbove(byTitle['Daniel Lurie'].significance,
        byTitle['Netscape'].significance)
    })

    it('reports inlink ratio as evidence without scoring on it', function() {
      const rows = scoreCohort({
        ...inputs,
        denoms: {
          'SF Board of Supervisors': { count: 60, capped: false },
          Netscape: { count: 4000, capped: false }
        }
      })
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      assert.approximately(byTitle['Netscape'].ratio, 2 / 4000, 1e-9)
      assert.equal(byTitle['Netscape'].totalInlinks, 4000)
      assert.isUndefined(byTitle['Netscape'].significanceTH, 'refinement removed')
    })

    it('adds a navbox-free significance when linksProse is supplied', function() {
      // Station: 100 cohort inlinks, but only 1 survives navbox stripping.
      // Plaza: barely linked by navboxes, well linked from prose.
      const rows = scoreCohort({
        cohort: [
          { title: 'Station', importance: 'high' },
          { title: 'Middle', importance: 'high' },
          { title: 'Plaza', importance: 'high' }
        ],
        qids: { Station: 'Q1', Middle: 'Q2', Plaza: 'Q3' },
        links: { Station: 100, Middle: 50, Plaza: 1 },
        linksProse: { Station: 1, Middle: 50, Plaza: 60 },
        claims: { Q1: 0, Q2: 5, Q3: 9 },
        assessments: {
          Station: { otherProjects: 0 },
          Middle: { otherProjects: 1 },
          Plaza: { otherProjects: 3 }
        },
        leads: {
          Station: { score: 0.9, term: 'Oakland' },
          Middle: { score: 0.5, term: 'Oakland' },
          Plaza: { score: 0 }
        }
      })
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      assert.equal(byTitle.Station.inlinkProse, 1)
      assert.equal(byTitle.Station.inlink, 100, 'raw metric is preserved')
      assert.isBelow(byTitle.Station.significanceProse, byTitle.Station.significance,
        'a navbox-inflated article falls once navbox links are removed')
      assert.isAbove(byTitle.Plaza.significanceProse, byTitle.Plaza.significance,
        'a prose-linked article rises')
    })

    it('leaves prose fields undefined when linksProse is absent', function() {
      const rows = scoreCohort(inputs)
      assert.isUndefined(rows[0].inlinkProse)
      assert.isUndefined(rows[0].significanceProse)
    })

    it('treats an article missing from linksProse as zero prose inlinks', function() {
      const rows = scoreCohort({ ...inputs, linksProse: { Netscape: 2 } })
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      assert.equal(byTitle['Daniel Lurie'].inlinkProse, 0)
    })

    it('ranks on canonical inlinks alone when they are supplied', function() {
      // Netflix leads on raw inlinks; the Gold Rush leads once redirects are
      // folded in, and the score must follow the canonical count.
      const rows = scoreCohort({
        ...inputs,
        linksCanonical: { 'SF Board of Supervisors': 2, Netscape: 40, 'Daniel Lurie': 345 }
      })
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      assert.equal(byTitle['Daniel Lurie'].inlinkCanonical, 345)
      assert.isAbove(byTitle['Daniel Lurie'].significance, byTitle['Netscape'].significance)
      assert.isAbove(byTitle['Netscape'].significance, byTitle['SF Board of Supervisors'].significance)
    })

    it('no longer applies the Top/High inlink-ratio refinement', function() {
      // significanceTH over-penalised articles that are both locally central
      // and globally famous; it is deliberately gone.
      const rows = scoreCohort({
        ...inputs,
        linksCanonical: { 'SF Board of Supervisors': 40, Netscape: 2, 'Daniel Lurie': 25 },
        denoms: {
          'SF Board of Supervisors': { count: 60, capped: false },
          Netscape: { count: 4000, capped: false }
        }
      })
      assert.isUndefined(rows[0].significanceTH)
    })

    it('keeps entangle and lead as reported evidence, out of the score', function() {
      const rows = scoreCohort({
        ...inputs,
        linksCanonical: { 'SF Board of Supervisors': 5, Netscape: 5, 'Daniel Lurie': 5 }
      })
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      // all three tie on inlinks, so the score must tie despite differing
      // entangle/lead/exclusive values
      assert.equal(byTitle['SF Board of Supervisors'].significance, byTitle['Netscape'].significance)
      assert.equal(byTitle['Netscape'].entangle, 1, 'evidence still reported')
      assert.equal(byTitle['SF Board of Supervisors'].lead, 0.9, 'evidence still reported')
    })

    it('defaults missing data to zero-valued metrics', function() {
      const rows = scoreCohort({
        cohort: [{ title: 'Ghost', importance: 'mid' }],
        qids: {}, links: {}, claims: {}, assessments: {}, leads: {}
      })
      assert.equal(rows[0].inlink, 0)
      assert.equal(rows[0].entangle, 0)
      assert.equal(rows[0].exclusive, 1)
      assert.equal(rows[0].lead, 0)
      assert.isNull(rows[0].qid)
    })
  })

  describe('pickCandidates', function() {
    it('splits demote (top/high, ascending) and promote (rest, descending)', function() {
      const rows = [
        { title: 'A', importance: 'high', significance: 0.1 },
        { title: 'B', importance: 'top', significance: 0.9 },
        { title: 'C', importance: 'low', significance: 0.95 },
        { title: 'D', importance: 'mid', significance: 0.2 },
        { title: 'E', importance: 'unknown', significance: 0.7 }
      ]
      const { demote, promote } = pickCandidates(rows, { perDirection: 2 })
      assert.deepEqual(demote.map(r => r.title), ['A', 'B'])
      assert.deepEqual(promote.map(r => r.title), ['C', 'E'])
    })
  })
})
