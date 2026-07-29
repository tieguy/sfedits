const { assert } = require('chai')
const { describe, it, before, beforeEach, after, afterEach } = require('mocha')
const nock = require('nock')

const { connect, testDsn, describeWithDb } = require('./helpers/db-helper')
const {
  titlesForQidsViaApi, normalizeTitle, titlesForQidsViaReplica, movesSince
} = require('../lib/title-resolver')

describe('title-resolver', function() {
  this.timeout(5000)

  afterEach(function() {
    nock.cleanAll()
  })

  describe('normalizeTitle', function() {
    it('converts underscores to spaces', function() {
      assert.equal(normalizeTitle('Cafe_du_Nord'), 'Cafe du Nord')
    })

    it('decodes a Buffer from the replicas', function() {
      assert.equal(normalizeTitle(Buffer.from('Café_du_Nord', 'utf8')), 'Café du Nord')
    })

    it('collapses repeated whitespace and trims', function() {
      assert.equal(normalizeTitle('  Alpha__Beta  '), 'Alpha Beta')
    })

    it('returns null for empty input', function() {
      assert.isNull(normalizeTitle(''))
      assert.isNull(normalizeTitle(null))
    })
  })

  describe('titlesForQidsViaApi', function() {
    it('maps QIDs to current titles per wiki', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              eswiki: { site: 'eswiki', title: 'Alfa' }
            } },
            Q20: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Beta' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10', 'Q20'], { languages: ['en', 'es'] })

      assert.deepEqual(result.get('Q10'), [
        { wikipedia: 'en', title: 'Alpha' },
        { wikipedia: 'es', title: 'Alfa' }
      ])
      assert.deepEqual(result.get('Q20'), [{ wikipedia: 'en', title: 'Beta' }])
    })

    it('filters to the requested languages', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              dewiki: { site: 'dewiki', title: 'Alpha (DE)' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10'], { languages: ['en'] })
      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('ignores non-wikipedia sitelinks', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, {
          entities: {
            Q10: { sitelinks: {
              enwiki: { site: 'enwiki', title: 'Alpha' },
              enwikiquote: { site: 'enwikiquote', title: 'Alpha' },
              commonswiki: { site: 'commonswiki', title: 'Category:Alpha' }
            } }
          }
        })

      const result = await titlesForQidsViaApi(['Q10'], {})
      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('batches requests at 50 ids, the API limit', async function() {
      const qids = Array.from({ length: 120 }, (_, i) => `Q${i + 1}`)
      let calls = 0

      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .times(3)
        .reply(200, function() {
          calls++
          return { entities: {} }
        })

      await titlesForQidsViaApi(qids, {})
      assert.equal(calls, 3)
    })

    it('omits entities the API reports as missing', async function() {
      nock('https://www.wikidata.org')
        .get('/w/api.php')
        .query(true)
        .reply(200, { entities: { Q99: { missing: '' } } })

      const result = await titlesForQidsViaApi(['Q99'], {})
      assert.isFalse(result.has('Q99'))
    })
  })
})

describeWithDb('title-resolver (replica SQL)', function() {
  this.timeout(30000)

  let pool

  before(async function() {
    pool = await connect(testDsn())

    // Minimal stand-ins for the replica schema. Types match production:
    // page_title and log_title are varbinary, which is what makes the driver
    // hand back Buffers.
    await pool.query('DROP TABLE IF EXISTS page_props')
    await pool.query('DROP TABLE IF EXISTS page')
    await pool.query('DROP TABLE IF EXISTS logging')

    await pool.query(`
      CREATE TABLE page (
        page_id        INT UNSIGNED NOT NULL PRIMARY KEY,
        page_namespace INT NOT NULL,
        page_title     VARBINARY(255) NOT NULL
      ) ENGINE=InnoDB`)
    await pool.query(`
      CREATE TABLE page_props (
        pp_page     INT UNSIGNED NOT NULL,
        pp_propname VARBINARY(60) NOT NULL,
        pp_value    BLOB NOT NULL,
        PRIMARY KEY (pp_page, pp_propname)
      ) ENGINE=InnoDB`)
    await pool.query(`
      CREATE TABLE logging (
        log_id        INT UNSIGNED NOT NULL PRIMARY KEY,
        log_type      VARBINARY(32) NOT NULL,
        log_action    VARBINARY(32) NOT NULL,
        log_timestamp BINARY(14) NOT NULL,
        log_namespace INT NOT NULL,
        log_title     VARBINARY(255) NOT NULL,
        log_params    BLOB NULL
      ) ENGINE=InnoDB`)

    // Bind the accented title as a parameter. MariaDB does NOT recognize \x
    // as an escape (its set is \0 \' \" \b \n \r \t \Z \\ \% \_), so a
    // literal like 'Caf\xc3\xa9' silently stores the bytes "Cafxc3xa9" - which
    // would make this fixture corrupt and defeat the very decoding it tests.
    await pool.query(
      'INSERT INTO page (page_id, page_namespace, page_title) VALUES (?, ?, ?)',
      [1, 0, Buffer.from('Café_du_Nord', 'utf8')])
    await pool.query(
      `INSERT INTO page (page_id, page_namespace, page_title) VALUES
       (2, 0, 'Alpha'), (3, 1, 'Talk_page')`)
    await pool.query(
      `INSERT INTO page_props (pp_page, pp_propname, pp_value) VALUES
       (1, 'wikibase_item', 'Q10'), (2, 'wikibase_item', 'Q20'),
       (3, 'wikibase_item', 'Q30')`)
  })

  after(async function() {
    if (pool) {
      await pool.query('DROP TABLE IF EXISTS page_props')
      await pool.query('DROP TABLE IF EXISTS page')
      await pool.query('DROP TABLE IF EXISTS logging')
      await pool.end()
    }
  })

  describe('titlesForQidsViaReplica', function() {
    it('joins page_props to page and decodes varbinary titles', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q10', 'Q20'], 'en')

      assert.deepEqual(result.get('Q10'), [{ wikipedia: 'en', title: 'Café du Nord' }])
      assert.deepEqual(result.get('Q20'), [{ wikipedia: 'en', title: 'Alpha' }])
    })

    it('returns strings, never Buffers', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q10'], 'en')
      assert.isString(result.get('Q10')[0].title)
    })

    it('restricts to mainspace', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q30'], 'en')
      assert.isFalse(result.has('Q30'))
    })

    it('omits QIDs with no local page', async function() {
      const result = await titlesForQidsViaReplica(pool, ['Q999'], 'en')
      assert.isFalse(result.has('Q999'))
    })
  })

  describe('movesSince', function() {
    beforeEach(async function() {
      await pool.query('TRUNCATE TABLE logging')
    })

    it('reads the new title out of the JSON log_params', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES (1, 'move', 'move', '20260722120000', 0, 'Old_Name', ?)`,
        [JSON.stringify({ '4::target': 'New Name', '5::noredir': '0' })])

      const moves = await movesSince(pool, '20260722000000')

      assert.equal(moves.length, 1)
      assert.deepEqual(moves[0], { from: 'Old Name', to: 'New Name' })
    })

    it('handles the legacy newline-delimited log_params', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES (2, 'move', 'move_redir', '20260722120000', 0, 'Legacy_Old', 'Legacy New\n0')`)

      const moves = await movesSince(pool, '20260722000000')

      assert.equal(moves.length, 1)
      assert.deepEqual(moves[0], { from: 'Legacy Old', to: 'Legacy New' })
    })

    it('ignores non-move log entries and older timestamps', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES
           (3, 'delete', 'delete', '20260722120000', 0, 'Gone', NULL),
           (4, 'move', 'move', '20260701120000', 0, 'Ancient', ?)`,
        [JSON.stringify({ '4::target': 'Ancient New' })])

      const moves = await movesSince(pool, '20260722000000')
      assert.equal(moves.length, 0)
    })

    it('ignores moves out of mainspace', async function() {
      await pool.query(
        `INSERT INTO logging
           (log_id, log_type, log_action, log_timestamp, log_namespace, log_title, log_params)
         VALUES (5, 'move', 'move', '20260722120000', 1, 'Talk_Old', ?)`,
        [JSON.stringify({ '4::target': 'Talk:New' })])

      const moves = await movesSince(pool, '20260722000000')
      assert.equal(moves.length, 0)
    })
  })
})
