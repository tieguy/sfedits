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

const { describe, before, after } = require('mocha')

const { connect, canConnect, migrate } = require('../../lib/db')

/**
 * Each mocha process gets its OWN database on the shared container.
 *
 * One shared `sfedits_test` database produced every flake in LUI-103: two
 * worktrees/sessions running suites concurrently (one's truncateAll wiping the
 * other's rows mid-test → FK failures), branches with different migration
 * sets sharing one schema ("Duplicate column name 'edit_filters'"), and
 * leftover fixture rows between runs. A per-process database makes those
 * collisions impossible by construction; `truncateAll` still isolates tests
 * WITHIN a run. The container itself stays shared and long-lived — there is
 * no reason to `test:db:stop` between runs any more (doing so still kills
 * other sessions' runs mid-flight).
 *
 * The name encodes its creation time so crashed runs' leftovers are GC'd by
 * the next run rather than accumulating.
 */
const RUN_DB = `sfedits_test_r${Math.floor(Date.now() / 1000)}_${process.pid}`
const GC_AGE_SECONDS = 3600

/** Server-level DSN: the container's bootstrap database, which always exists. */
function serverDsn() {
  const base = process.env.SFEDITS_TEST_DB
    || 'mysql://root:sfedits-test@127.0.0.1:3307/sfedits_test'
  return base
}

/** DSN for this process's own disposable database. */
function testDsn() {
  // An explicit SFEDITS_TEST_DB is honored exactly: whoever sets it has
  // chosen a specific database and gets to keep both halves if it is shared.
  if (process.env.SFEDITS_TEST_DB) return process.env.SFEDITS_TEST_DB
  return `mysql://root:sfedits-test@127.0.0.1:3307/${RUN_DB}`
}

let setupPromise = null

/** Create this run's database (once per process) and GC stale ones. */
function ensureRunDatabase() {
  if (testDsn() === serverDsn()) return Promise.resolve() // explicit override
  if (!setupPromise) {
    setupPromise = (async () => {
      const pool = await connect(serverDsn())
      try {
        // Collation mirrors production ToolsDB (utf8mb4_bin is load-bearing).
        await pool.query(
          `CREATE DATABASE IF NOT EXISTS ${RUN_DB} CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`)

        // GC databases left by crashed runs (creation epoch in the name).
        const rows = await pool.query(
          "SELECT schema_name AS s FROM information_schema.schemata WHERE schema_name LIKE 'sfedits\\_test\\_r%'")
        const cutoff = Math.floor(Date.now() / 1000) - GC_AGE_SECONDS
        for (const row of rows) {
          const name = String(row.s)
          const epoch = Number((name.match(/_r(\d+)_/) || [])[1])
          if (Number.isFinite(epoch) && epoch < cutoff && name !== RUN_DB) {
            await pool.query(`DROP DATABASE IF EXISTS ${name}`).catch(() => {})
          }
        }
      } finally {
        await pool.end()
      }
    })()
  }
  return setupPromise
}

// Root-level cleanup: drop this run's database when the process's suites end.
// (Registered once — this module is a singleton however many files require it.)
after(async function() {
  if (!setupPromise) return
  this.timeout(20000)
  try {
    const pool = await connect(serverDsn())
    await pool.query(`DROP DATABASE IF EXISTS ${RUN_DB}`)
    await pool.end()
  } catch (e) { /* container already gone; the GC in the next run covers it */ }
})

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

      // Probe the SERVER (bootstrap database), not this run's database —
      // which does not exist until ensureRunDatabase creates it.
      if (await canConnect(serverDsn())) {
        await ensureRunDatabase()
        return
      }

      if (process.env.SFEDITS_REQUIRE_DB === '1') {
        throw new Error(
          `SFEDITS_REQUIRE_DB=1 but the database at ${serverDsn()} is unreachable`)
      }

      console.log(
        `\n  [skipping "${title}": no database server at ${serverDsn()}.` +
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
