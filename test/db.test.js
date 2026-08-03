const { assert } = require('chai')
const { it, before, after } = require('mocha')

const { connect, migrate, testDsn, describeWithDb } = require('./helpers/db-helper')

describeWithDb('db migrations', function() {
  this.timeout(30000)

  let pool

  before(async function() {
    pool = await connect(testDsn())
  })

  after(async function() {
    if (pool) await pool.end()
  })

  it('creates every table', async function() {
    await migrate(pool)

    const rows = await pool.query(
      'SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()')
    const tables = rows.map(r => String(r.t))

    for (const expected of
      ['topics', 'articles', 'topic_articles', 'subscriptions', 'schema_migrations']) {
      assert.include(tables, expected)
    }
  })

  it('records each migration once however often it runs', async function() {
    await migrate(pool)
    await migrate(pool)

    const rows = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations')
    assert.equal(Number(rows[0].n), 2, 'both 001 and 002 migrations recorded exactly once')
  })

  it('cascades topic deletion to memberships and subscriptions', async function() {
    await migrate(pool)

    const topic = await pool.query(
      `INSERT INTO topics (region_qid, filters_hash) VALUES (?, ?)`,
      ['Q62', 'a'.repeat(64)])
    const topicId = topic.insertId

    const article = await pool.query(
      `INSERT INTO articles (wikipedia, title, wikidata_qid) VALUES (?, ?, ?)`,
      ['en', 'Alpha', 'Q10'])

    await pool.query(
      `INSERT INTO topic_articles (topic_id, article_id, source) VALUES (?, ?, ?)`,
      [topicId, article.insertId, 'admin'])
    await pool.query(
      `INSERT INTO subscriptions (topic_id, owner_user, delivery_type, delivery_config)
       VALUES (?, ?, ?, ?)`,
      [topicId, 'Example', 'discord', JSON.stringify({ webhook_url: 'https://x/y' })])

    await pool.query('DELETE FROM topics WHERE id = ?', [topicId])

    const ta = await pool.query(
      'SELECT COUNT(*) AS n FROM topic_articles WHERE topic_id = ?', [topicId])
    const subs = await pool.query(
      'SELECT COUNT(*) AS n FROM subscriptions WHERE topic_id = ?', [topicId])

    assert.equal(Number(ta[0].n), 0)
    assert.equal(Number(subs[0].n), 0)
  })

  it('rejects a duplicate region + filters_hash', async function() {
    await migrate(pool)

    const hash = 'b'.repeat(64)
    const insert = () => pool.query(
      'INSERT INTO topics (region_qid, filters_hash) VALUES (?, ?)', ['Q99', hash])

    await insert()

    // Capture the rejection rather than assert.fail() inside a try: assert.fail
    // throws INSIDE the try and the catch swallows it, so such a test passes
    // even when the insert succeeded.
    const error = await insert().then(() => null, e => e)

    assert.isNotNull(error, 'the second insert must be rejected')
    assert.equal(error.code, 'ER_DUP_ENTRY')
  })
})
