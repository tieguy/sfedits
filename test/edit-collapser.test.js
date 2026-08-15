const { assert } = require('chai')
const sinon = require('sinon')
const { EditCollapser, combineDiffUrls } = require('../lib/edit-collapser')

const WINDOW_MS = 15 * 60 * 1000

function makeEdit(overrides = {}) {
  return Object.assign({
    wikipedia: 'English Wikipedia',
    page: 'San Francisco',
    user: '192.168.1.1',
    url: 'https://en.wikipedia.org/w/index.php?diff=100&oldid=99'
  }, overrides)
}

// Let pending promise chains (flush posts await thread refs) settle.
// setImmediate is left unfaked so this works alongside the fake clock.
const settle = () => new Promise(resolve => setImmediate(resolve))

describe('edit-collapser', function() {

  describe('combineDiffUrls', function() {
    it('spans from the first oldid to the last diff revision', function() {
      const combined = combineDiffUrls(
        'https://en.wikipedia.org/w/index.php?diff=101&oldid=100',
        'https://en.wikipedia.org/w/index.php?diff=105&oldid=104'
      )
      assert.equal(combined, 'https://en.wikipedia.org/w/index.php?diff=105&oldid=100')
    })

    it('returns null when a URL is missing diff or oldid params', function() {
      assert.isNull(combineDiffUrls(
        'https://en.wikipedia.org/w/index.php?diff=101&oldid=100',
        'https://en.wikipedia.org/wiki/San_Francisco'
      ))
      assert.isNull(combineDiffUrls('not a url', 'also not a url'))
    })
  })

  describe('EditCollapser', function() {
    let clock, postEdit, collapser

    beforeEach(function() {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      postEdit = sinon.spy()
      collapser = new EditCollapser({ windowMs: WINDOW_MS, postEdit })
    })

    afterEach(function() {
      clock.restore()
    })

    it('posts the first edit immediately', function() {
      const edit = makeEdit()
      const result = collapser.add(edit)
      assert.equal(result.action, 'posted')
      assert.equal(postEdit.callCount, 1)
      assert.equal(postEdit.firstCall.args[0], edit)
      assert.equal(postEdit.firstCall.args[1], 1)
      assert.isNull(postEdit.firstCall.args[2])
    })

    it('counts buffered edits across windows, which a restart drops', async function() {
      assert.equal(collapser.pendingCount(), 0)

      collapser.add(makeEdit())
      assert.equal(collapser.pendingCount(), 0, 'the leading edit posts, it does not buffer')

      collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=101&oldid=100' }))
      collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=102&oldid=101' }))
      collapser.add(makeEdit({ page: 'Oakland' }))
      collapser.add(makeEdit({ page: 'Oakland', url: 'https://en.wikipedia.org/w/index.php?diff=201&oldid=200' }))

      assert.equal(collapser.pendingCount(), 3, 'two for San Francisco, one for Oakland')

      clock.tick(WINDOW_MS)
      await settle()
      assert.equal(collapser.pendingCount(), 0, 'flushing empties the buffers')
    })

    it('buffers edits arriving inside the window and flushes one combined post', async function() {
      collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=101&oldid=100' }))
      const r2 = collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=102&oldid=101' }))
      const r3 = collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=103&oldid=102' }))

      assert.equal(r2.action, 'buffered')
      assert.equal(r3.action, 'buffered')
      assert.equal(postEdit.callCount, 1)

      clock.tick(WINDOW_MS)
      await settle()

      assert.equal(postEdit.callCount, 2)
      const [combined, count] = postEdit.secondCall.args
      assert.equal(count, 2)
      assert.equal(combined.collapsedCount, 2)
      // Diff spans edit 2's oldid through edit 3's new revision
      assert.equal(combined.url, 'https://en.wikipedia.org/w/index.php?diff=103&oldid=101')
      // Constituent URLs preserved for per-revision post logging (revdel)
      assert.deepEqual(combined.collapsedUrls, [
        'https://en.wikipedia.org/w/index.php?diff=102&oldid=101',
        'https://en.wikipedia.org/w/index.php?diff=103&oldid=102'
      ])
    })

    it('keeps the last edit URL when a buffered URL cannot be combined', async function() {
      collapser.add(makeEdit())
      collapser.add(makeEdit({ url: 'not a url' }))
      collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=103&oldid=102' }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.equal(combined.url, 'https://en.wikipedia.org/w/index.php?diff=103&oldid=102')
    })

    it('does not collapse edits by different users or to different pages', function() {
      collapser.add(makeEdit({ user: 'Alice' }))
      collapser.add(makeEdit({ user: 'Bob' }))
      collapser.add(makeEdit({ page: 'Daniel Lurie' }))
      assert.equal(postEdit.callCount, 3)
    })

    it('closes a quiet window so a later edit posts immediately again', async function() {
      collapser.add(makeEdit())
      clock.tick(WINDOW_MS)
      await settle()
      const result = collapser.add(makeEdit())
      assert.equal(result.action, 'posted')
      assert.equal(postEdit.callCount, 2)
    })

    it('keeps collapsing a sustained burst into one post per window', async function() {
      // Edit every 5 minutes for 45 minutes
      for (let i = 0; i < 9; i++) {
        collapser.add(makeEdit({
          url: `https://en.wikipedia.org/w/index.php?diff=${101 + i}&oldid=${100 + i}`
        }))
        clock.tick(5 * 60 * 1000)
        await settle()
      }
      // 1 immediate post + one combined post per elapsed window, never 1:1
      assert.isAtMost(postEdit.callCount, 4)
      assert.isAtLeast(postEdit.callCount, 3)
      const counts = postEdit.getCalls().map(c => c.args[1])
      assert.equal(counts.reduce((a, b) => a + b, 0), 9)
    })

    it('flushAll posts pending buffers', async function() {
      collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=101&oldid=100' }))
      collapser.add(makeEdit({ url: 'https://en.wikipedia.org/w/index.php?diff=102&oldid=101' }))
      collapser.flushAll()
      await settle()
      assert.equal(postEdit.callCount, 2)
      assert.equal(postEdit.secondCall.args[1], 1)
    })

    describe('threading', function() {
      const refsFor = n => ({
        bluesky: { uri: `at://did:plc:x/post/${n}`, cid: `cid${n}` },
        mastodon: `${n}`
      })

      it('passes the leading post refs as thread root and parent to the combined post', async function() {
        const refs1 = refsFor(1)
        postEdit = sinon.stub()
        postEdit.onFirstCall().resolves(refs1)
        postEdit.onSecondCall().resolves(refsFor(2))
        collapser = new EditCollapser({ windowMs: WINDOW_MS, postEdit })

        collapser.add(makeEdit())
        collapser.add(makeEdit())
        clock.tick(WINDOW_MS)
        await settle()

        assert.equal(postEdit.callCount, 2)
        const thread = postEdit.secondCall.args[2]
        assert.deepEqual(thread, { root: refs1, parent: refs1 })
      })

      it('advances the parent while keeping the root across sustained windows', async function() {
        const refs1 = refsFor(1)
        const refs2 = refsFor(2)
        postEdit = sinon.stub()
        postEdit.onCall(0).resolves(refs1)
        postEdit.onCall(1).resolves(refs2)
        postEdit.onCall(2).resolves(refsFor(3))
        collapser = new EditCollapser({ windowMs: WINDOW_MS, postEdit })

        collapser.add(makeEdit())
        collapser.add(makeEdit())
        clock.tick(WINDOW_MS)
        await settle()

        // Burst continues into the reopened window
        collapser.add(makeEdit())
        clock.tick(WINDOW_MS)
        await settle()

        assert.equal(postEdit.callCount, 3)
        const thread = postEdit.thirdCall.args[2]
        assert.deepEqual(thread, { root: refs1, parent: refs2 })
      })

      it('keeps the previous thread refs when a combined post fails', async function() {
        const refs1 = refsFor(1)
        postEdit = sinon.stub()
        postEdit.onCall(0).resolves(refs1)
        postEdit.onCall(1).resolves(null) // combined post blocked/failed
        postEdit.onCall(2).resolves(refsFor(3))
        collapser = new EditCollapser({ windowMs: WINDOW_MS, postEdit })

        collapser.add(makeEdit())
        collapser.add(makeEdit())
        clock.tick(WINDOW_MS)
        await settle()

        collapser.add(makeEdit())
        clock.tick(WINDOW_MS)
        await settle()

        const thread = postEdit.thirdCall.args[2]
        assert.deepEqual(thread, { root: refs1, parent: refs1 })
      })

      it('posts standalone when the leading post produced no refs', async function() {
        postEdit = sinon.stub()
        postEdit.onCall(0).resolves(null)
        postEdit.onCall(1).resolves(refsFor(2))
        collapser = new EditCollapser({ windowMs: WINDOW_MS, postEdit })

        collapser.add(makeEdit())
        collapser.add(makeEdit())
        clock.tick(WINDOW_MS)
        await settle()

        assert.isNull(postEdit.secondCall.args[2])
      })
    })
  })

  describe('combine aggregation', function() {
    let clock, postEdit, collapser

    beforeEach(function() {
      clock = sinon.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      postEdit = sinon.spy()
      collapser = new EditCollapser({ windowMs: WINDOW_MS, postEdit })
    })

    afterEach(function() {
      clock.restore()
    })

    it('sums delta from all buffered edits (leading+buffered)', async function() {
      // Add 3 edits: first posts immediately, next 2 buffer
      // Then 3 more: they buffer in a second window
      // This tests that within a window, buffered edits are summed
      collapser.add(makeEdit({ delta: 10, minor: false, robot: false }))
      collapser.add(makeEdit({ delta: 50, minor: false, robot: false }))
      collapser.add(makeEdit({ delta: 80, minor: false, robot: false }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined, count] = postEdit.secondCall.args
      // combined covers buffered edits: 50 + 80 = 130
      assert.equal(combined.delta, 130)
      assert.equal(count, 2)
    })

    it('treats null deltas as 0 in the sum', async function() {
      collapser.add(makeEdit({ delta: 10, minor: false, robot: false }))
      collapser.add(makeEdit({ delta: 50, minor: false, robot: false }))
      collapser.add(makeEdit({ delta: null, minor: false, robot: false }))
      collapser.add(makeEdit({ delta: 30, minor: false, robot: false }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      // Buffered: 50 + null(0) + 30 = 80
      assert.equal(combined.delta, 80)
    })

    it('returns null delta when all constituent deltas are null', async function() {
      collapser.add(makeEdit({ delta: null, minor: false, robot: false }))
      collapser.add(makeEdit({ delta: null, minor: false, robot: false }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.isNull(combined.delta)
    })

    it('requires every constituent to be minor for the combined edit to be minor', async function() {
      collapser.add(makeEdit({ delta: 50, minor: true, robot: false }))
      collapser.add(makeEdit({ delta: 30, minor: false, robot: false }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.isFalse(combined.minor)
    })

    it('marks combined edit as minor only when all constituents are minor', async function() {
      collapser.add(makeEdit({ delta: 50, minor: true, robot: false }))
      collapser.add(makeEdit({ delta: 30, minor: true, robot: false }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.isTrue(combined.minor)
    })

    it('requires every constituent to be robot for the combined edit to be robot', async function() {
      collapser.add(makeEdit({ delta: 50, minor: false, robot: true }))
      collapser.add(makeEdit({ delta: 30, minor: false, robot: false }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.isFalse(combined.robot)
    })

    it('marks combined edit as robot only when all constituents are robot', async function() {
      collapser.add(makeEdit({ delta: 50, minor: false, robot: true }))
      collapser.add(makeEdit({ delta: 30, minor: false, robot: true }))

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.isTrue(combined.robot)
    })

    it('keeps last-edit behavior for other fields', async function() {
      const edit1 = makeEdit({ comment: 'first', minor: false, robot: false })
      const edit2 = makeEdit({ comment: 'second', minor: false, robot: false })

      collapser.add(edit1)
      collapser.add(edit2)

      clock.tick(WINDOW_MS)
      await settle()

      const [combined] = postEdit.secondCall.args
      assert.equal(combined.comment, edit2.comment)
    })
  })
})
