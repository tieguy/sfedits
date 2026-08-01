#!/usr/bin/env node
/**
 * Nightly topic rebuild.
 *
 * On Toolforge this runs as a scheduled job:
 *   toolforge jobs run rebuild-topics \
 *     --command "node scripts/rebuild-topics.js all" \
 *     --image <build-service-image> --schedule '@daily' --mem 1Gi
 *
 * Usage:
 *   node scripts/rebuild-topics.js all            rebuild every topic
 *   node scripts/rebuild-topics.js topic <id>     rebuild one topic
 *   node scripts/rebuild-topics.js gc             collect orphaned topics
 */

const { loadConfig } = require('../lib/config')
const { createTopicStore } = require('../lib/topic-store')
const { rebuildTopic, rebuildAll } = require('../lib/rebuild')

function reportOne(result) {
  if (!result.ok) {
    console.error(`topic ${result.topicId}: FAILED - ${result.error}`)
    return
  }

  const parts = [
    `+${result.added.length}`,
    `-${result.removed.length}`,
    `~${result.renamed.length} renamed`
  ]
  console.log(`topic ${result.topicId}: ${parts.join(' ')}`)

  for (const rename of result.renamed) {
    console.log(`  renamed ${rename.qid}: "${rename.from}" -> "${rename.to}"`)
  }
  if (result.newArticles.length > 0) {
    console.log(`  new articles: ${result.newArticles.join(', ')}`)
  }
}

async function main() {
  const [mode, argument] = process.argv.slice(2)

  if (!mode || !['all', 'topic', 'gc'].includes(mode)) {
    console.error('usage: rebuild-topics.js all | topic <id> | gc')
    process.exit(2)
  }

  const config = loadConfig()
  if (!config.topic_store) {
    console.error('config has no topic_store stanza')
    process.exit(1)
  }

  const store = createTopicStore({ config: config.topic_store })

  try {
    if (mode === 'gc') {
      const collected = await store.collectOrphanTopics()
      console.log(collected.length > 0
        ? `collected ${collected.length} orphaned topic(s): ${collected.join(', ')}`
        : 'no orphaned topics')
      return
    }

    if (mode === 'topic') {
      if (!argument) {
        console.error('topic mode needs a topic id')
        process.exit(2)
      }
      reportOne(await rebuildTopic(store, Number(argument)))
      return
    }

    const results = await rebuildAll(store)
    results.forEach(reportOne)

    const failed = results.filter(r => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} topics rebuilt`)
    if (failed > 0) process.exitCode = 1
  } finally {
    await store.close()
  }
}

main().catch(error => {
  console.error('rebuild-topics failed:', error.message)
  process.exit(1)
})
