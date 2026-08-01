#!/usr/bin/env node
/**
 * Apply database migrations.
 *
 * On Toolforge this is a one-off job run once per deploy that changes the
 * schema:
 *   toolforge jobs run migrate --command "node scripts/migrate.js" \
 *     --image <build-service-image> --wait
 *
 * Reads the same `topic_store` stanza the bot and webservice use, so there is
 * no second place to configure credentials. Safe to run repeatedly: every
 * migration is recorded in schema_migrations and skipped thereafter.
 *
 * Usage:
 *   node scripts/migrate.js           apply pending migrations
 *   node scripts/migrate.js status    list what is applied, change nothing
 */

const mariadb = require('mariadb')

const { loadConfig } = require('../lib/config')
const { migrate } = require('../lib/db')
const { connectionOptions } = require('../lib/topic-store')

async function main() {
  const mode = process.argv[2] || 'apply'
  if (!['apply', 'status'].includes(mode)) {
    console.error('usage: migrate.js [apply|status]')
    process.exit(2)
  }

  const config = loadConfig()
  if (!config.topic_store) {
    console.error('config has no topic_store stanza')
    process.exit(1)
  }

  const pool = mariadb.createPool(connectionOptions(config.topic_store))

  try {
    if (mode === 'status') {
      const rows = await pool.query(
        'SELECT version, applied_at FROM schema_migrations ORDER BY version')
        .catch(() => [])
      if (rows.length === 0) {
        console.log('no migrations applied yet')
      } else {
        for (const row of rows) {
          console.log(`${row.version}\t${row.applied_at.toISOString()}`)
        }
      }
      return
    }

    const before = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations')
      .then(rows => Number(rows[0].n), () => 0)

    await migrate(pool)

    const after = await pool.query('SELECT COUNT(*) AS n FROM schema_migrations')
      .then(rows => Number(rows[0].n))

    console.log(after > before
      ? `applied ${after - before} migration(s); ${after} total`
      : `already up to date; ${after} migration(s) applied`)
  } finally {
    await pool.end()
  }
}

main().catch(error => {
  console.error('migrate failed:', error.message)
  process.exit(1)
})
