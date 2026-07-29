/**
 * MariaDB access for the topic store.
 *
 * This is the first database code in the repo. It stays deliberately small: a
 * DSN parser, a pool factory, and a migration runner that applies every .sql
 * file in db/migrations once and records it. Production (ToolsDB) and the
 * disposable podman container in tests run the same path.
 *
 * @see docs/design-plans/2026-07-23-place-bot-platform.md
 */

const fs = require('fs')
const path = require('path')

const mariadb = require('mariadb')

const MIGRATIONS_DIR = path.join(__dirname, '..', 'db', 'migrations')

/** Parse a mysql:// DSN into connector options. */
function parseDsn(dsn) {
  const url = new URL(dsn)
  return {
    host: url.hostname,
    port: Number(url.port || 3306),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: url.pathname.replace(/^\//, ''),
    connectionLimit: 5,
    // Return BIGINT as JS numbers; our ids stay far below 2^53.
    bigIntAsNumber: true
  }
}

/** Pool for a DSN, verified reachable before it is handed back. */
async function connect(dsn) {
  const pool = mariadb.createPool(parseDsn(dsn))
  try {
    const conn = await pool.getConnection()
    conn.release()
  } catch (error) {
    await pool.end().catch(() => {})
    throw new Error(
      `Cannot reach the database at ${dsn}: ${error.message}\n` +
      'Start the test one with: npm run test:db:start')
  }
  return pool
}

/** Can we reach this database? Never throws. Fails fast rather than stalling. */
async function canConnect(dsn) {
  let pool = null
  try {
    // The connector's default acquireTimeout is ~10s, which turns "no database"
    // into a ten-second stall per suite instead of an instant skip.
    pool = mariadb.createPool({
      ...parseDsn(dsn),
      connectionLimit: 1,
      connectTimeout: 1000,
      initializationTimeout: 1000,
      acquireTimeout: 2000
    })
    const conn = await pool.getConnection()
    conn.release()
    return true
  } catch {
    return false
  } finally {
    if (pool) await pool.end().catch(() => {})
  }
}

/**
 * Apply every migration not already recorded. Safe to call repeatedly.
 *
 * Migrations are immutable once shipped: a schema change adds 002-*.sql rather
 * than editing 001, because 001 is already recorded in schema_migrations on any
 * database that has run it and will never be re-read.
 */
async function migrate(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    VARCHAR(64) NOT NULL,
      applied_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `)

  const applied = new Set(
    (await pool.query('SELECT version FROM schema_migrations')).map(r => String(r.version)))

  const files = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort()

  for (const file of files) {
    const version = file.replace(/\.sql$/, '')
    if (applied.has(version)) continue

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8')
    // The connector sends one statement per query() call unless
    // multipleStatements is enabled; splitting keeps that off.
    for (const statement of sql.split(/;\s*$/m).map(s => s.trim()).filter(Boolean)) {
      await pool.query(statement)
    }

    await pool.query('INSERT INTO schema_migrations (version) VALUES (?)', [version])
  }
}

module.exports = { parseDsn, connect, canConnect, migrate, MIGRATIONS_DIR }
