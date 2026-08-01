const { assert } = require('chai')

const {
  percentileRanks, median, leadScore, scoreCohort, pickCandidates, BAY_AREA_RE
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

    it('uses inlink ratio for Top/High significance when denominators exist', function() {
      // Netscape: high raw inlinks but a tiny share of its total backlinks;
      // BoS: fewer raw inlinks but the task force is most of its links.
      const rows = scoreCohort({
        ...inputs,
        denoms: {
          'SF Board of Supervisors': { count: 60, capped: false },
          Netscape: { count: 4000, capped: false }
        }
      })
      const byTitle = Object.fromEntries(rows.map(r => [r.title, r]))
      assert.approximately(byTitle['Netscape'].ratio, 2 / 4000, 1e-9)
      assert.isAbove(byTitle['SF Board of Supervisors'].significanceTH,
        byTitle['Netscape'].significanceTH)
      // Daniel Lurie is not Top/High, so no denominator-based score
      assert.isUndefined(byTitle['Daniel Lurie'].significanceTH)
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
