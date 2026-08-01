/**
 * Test support for the MariaDB-backed topic store.
 *
 * The topic store is tested against a real MariaDB because its schema
 * constraints and joins ARE the behavior under test - SQLite would run a
 * different dialect and mocks would verify nothing.
 *
 * When the database is not reachable these suites report as PENDING, not as
 * failures, so `npm test` is green on a machine that has never run a container.
 * Pending is visible in the report, so a skipped database suite is never
 * mistaken for a passing one.
 *
 * Start the database with:  npm run test:db:start
 * Require it (fail instead of skip):  SFEDITS_REQUIRE_DB=1 npm test
 */

const { describe, before } = require('mocha')

const { connect, canConnect, migrate } = require('../../lib/db')

/** DSN for the disposable test database, overridable by env. */
function testDsn() {
  return process.env.SFEDITS_TEST_DB
    || 'mysql://root:sfedits-test@127.0.0.1:3307/sfedits_test'
}

/**
 * describe() for a suite that needs the database.
 *
 * The skip decision cannot be made at suite-definition time - mocha builds the
 * tree synchronously and reachability is an async question. So the suite is
 * always defined, and its before() hook calls skip() when the database is not
 * reachable, marking the whole suite PENDING: visible in the report, not a
 * failure.
 *
 * Set SFEDITS_REQUIRE_DB=1 to turn unreachability back into a hard failure -
 * use that anywhere the database is supposed to be up and a silent skip would
 * hide a real regression.
 */
function describeWithDb(title, fn) {
  return describe(title, function() {
    const suite = this

    before(async function() {
      // Set the timeout INSIDE the hook. mocha stamps a hook's timeout when the
      // hook is created, and `this.timeout(30000)` in the suite body runs after
      // this before() was registered - so without this line the probe keeps the
      // 2000ms default and TIMES OUT rather than skipping, which is precisely
      // the red-on-a-fresh-clone outcome this mechanism exists to prevent.
      this.timeout(20000)

      if (await canConnect(testDsn())) return

      if (process.env.SFEDITS_REQUIRE_DB === '1') {
        throw new Error(
          `SFEDITS_REQUIRE_DB=1 but the database at ${testDsn()} is unreachable`)
      }

      console.log(
        `\n  [skipping "${title}": no database at ${testDsn()}.` +
        '\n   Start one with: npm run test:db:start]\n')
      suite.ctx.skip()
    })

    fn.call(this)
  })
}

/**
 * Drop all rows, preserving schema. Used between tests.
 *
 * All statements run on ONE explicitly-held connection: FOREIGN_KEY_CHECKS is a
 * session variable, so a pooled `pool.query()` per statement can land the
 * TRUNCATE of a parent table on a connection where checks are still enabled,
 * failing with ER_TRUNCATE_ILLEGAL_FK. That failure is order-dependent - it
 * passes locally and fails under concurrency, which is the worst kind.
 */
async function truncateAll(pool) {
  const conn = await pool.getConnection()
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0')
    for (const table of ['topic_articles', 'subscriptions', 'articles', 'topics']) {
      await conn.query(`TRUNCATE TABLE ${table}`)
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1')
  } finally {
    conn.release()
  }
}

module.exports = { connect, migrate, truncateAll, testDsn, describeWithDb, canConnect }
