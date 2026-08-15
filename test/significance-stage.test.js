const { describe, it } = require('mocha')
const { assert } = require('chai')

const { filterBySignificance } = require('../lib/significance-stage')

const EDIT = { page: 'Testville', url: 'https://en.wikipedia.org/w/index.php?diff=200&oldid=100' }
const PAIR = { prev: 'old text here.', curr: 'old text here. And new prose.', tags: [] }
const GNOME_PAIR = { prev: 'text {{a}}', curr: 'text {{b}}', tags: [] }

function consumer(name, filters) {
  // Mirrors the real consumer shape: subType carries the delivery type.
  return { type: 'delivery', subType: name, editFilters: filters }
}

function deps(overrides = {}) {
  const logs = []
  return {
    logs,
    fetchRevisionPair: async () => PAIR,
    log: line => logs.push(line),
    label: c => c.subType,
    ...overrides
  }
}

describe('significance-stage', function () {
  it('skips entirely (no fetch) when no consumer opts in', async function () {
    let fetched = false
    const d = deps({ fetchRevisionPair: async () => { fetched = true; return PAIR } })
    const consumers = [consumer('discord', { bots: false })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.deepEqual(kept, consumers)
    assert.isFalse(fetched)
    assert.lengthOf(d.logs, 0)
  })

  it('keeps everything and logs the verdict in log mode', async function () {
    const d = deps({ fetchRevisionPair: async () => GNOME_PAIR })
    const consumers = [consumer('discord', { substantive_only: 'log' })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.startsWith('substantive-verdict: Testville substantive=false')))
    assert.isFalse(d.logs.some(l => l.startsWith('filtered:')))
  })

  it('drops only enforcing consumers on a non-substantive verdict', async function () {
    const d = deps({ fetchRevisionPair: async () => GNOME_PAIR })
    const consumers = [
      consumer('discord', { substantive_only: true }),
      consumer('mastodon', { substantive_only: 'log' }),
      consumer('bluesky', null)
    ]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.deepEqual(kept.map(c => c.subType), ['mastodon', 'bluesky'])
    assert.isTrue(d.logs.some(l => l === 'filtered: Testville for discord (substantive_only: template-bag)'))
  })

  it('keeps every consumer on a substantive verdict', async function () {
    const d = deps()
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.includes('substantive=true')))
  })

  it('CONSERVATIVE PASS: keeps every consumer when the fetch throws', async function () {
    const d = deps({ fetchRevisionPair: async () => { throw new Error('network down') } })
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.includes('classification failed, passing')))
  })

  it('CONSERVATIVE PASS: keeps every consumer when the pair is unavailable (null)', async function () {
    const d = deps({ fetchRevisionPair: async () => null })
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
  })

  it('CONSERVATIVE PASS: fallback verdicts (revdeleted content) never drop', async function () {
    const d = deps({ fetchRevisionPair: async () => ({ prev: null, curr: 'x', tags: [] }) })
    const consumers = [consumer('discord', { substantive_only: true })]
    const kept = await filterBySignificance(EDIT, consumers, d)
    assert.lengthOf(kept, 1)
    assert.isTrue(d.logs.some(l => l.includes('fallback=missing-content')))
  })

  it('takes channel overrides only from consumers that opted in', async function () {
    const d = deps({ fetchRevisionPair: async () => GNOME_PAIR })
    const consumers = [
      // not opted in — its channels must NOT apply
      consumer('bluesky', { substantive_channels: { 'template-bag': 'substantive' } }),
      consumer('discord', { substantive_only: true })
    ]
    const kept = await filterBySignificance(EDIT, consumers, d)
    // With default channels the gnome pair is non-substantive → discord drops.
    assert.deepEqual(kept.map(c => c.subType), ['bluesky'])
  })

  it('logs the new revision tags as annotation', async function () {
    const d = deps({ fetchRevisionPair: async () => ({ ...PAIR, tags: ['mw-undo'] }) })
    await filterBySignificance(EDIT, [consumer('discord', { substantive_only: 'log' })], d)
    assert.isTrue(d.logs.some(l => l.includes('tags=[mw-undo]')))
  })
})
