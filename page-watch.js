#!/usr/bin/env node

const fs = require('fs')
const async = require('async')
const minimist = require('minimist')
const Mastodon = require('./lib/mastodon-client')
const Mustache = require('mustache')
const { EditStream } = require('./lib/edit-stream')
const { enrichIPsInText, initializeReader } = require('./lib/geolocation')
const { captureDiffImage } = require('./lib/diff-image')
const { buildFacets } = require('./lib/bluesky-utils')
const { post: deliveryPost, resolveConfigDeliveries } = require('./lib/delivery')
const { startWatchlistSync, isWatched } = require('./lib/watchlist-sync')
const { createTopicStore } = require('./lib/topic-store')
const { createTopicIndex } = require('./lib/topic-index')
const { deliverAll } = require('./lib/subscription-delivery')
const { createHealthTracker } = require('./lib/subscription-health')
const { SubscriptionLimiter } = require('./lib/delivery-limits')

// Topic store and index are null until main() starts them; the bot runs
// without a topic_store stanza exactly as it did before this phase.
let topicStore = null
let topicIndex = null
let subscriptionLimiter = null
const subscriptionHealth = createHealthTracker()
const { startClaimWatch, handleWikidataEdit } = require('./lib/wikidata-claim-watch')
const { fetchDiffHtml, verifyDiffPage } = require('./lib/diff-page')
const { recordPost, entryDeliveries } = require('./lib/post-log')
const { EditCollapser, DEFAULT_WINDOW_MINUTES } = require('./lib/edit-collapser')
const { startSweeper } = require('./lib/revdel-check')
const { loadConfig } = require('./lib/config')
const { passesMetadata, needsContentCheck, isCosmeticOnly, metadataDropReason } = require('./lib/edit-filters')
const { filterBySignificance } = require('./lib/significance-stage')
const {
  startRun,
  touchRun,
  explainPreviousRun,
  installStopHandlers
} = require('./lib/shutdown')

const path = require('path')

const argv = minimist(process.argv.slice(2), {
  default: {
    verbose: false
  }
})

const HEARTBEAT_DIR = path.join(__dirname, 'data')
function writeHeartbeat(name) {
  try {
    fs.writeFileSync(path.join(HEARTBEAT_DIR, `heartbeat-${name}`), Date.now().toString())
  } catch (e) {
    // Non-fatal: data dir may not exist in test
  }
}

function getConfig() {
  // Load config from config.base.json (committed) + config.json (local overlay, optional)
  // + SFEDITS_* secret env vars. Both files resolve from the current working directory,
  // which is the repo root when the bot starts.
  return loadConfig()
}

// Builds Wikipedia article URL from edit URL. Returns null if URL is malformed.
function getArticleUrl(editUrl, pageName) {
  try {
    const url = new URL(editUrl)
    const lang = url.hostname.split('.')[0]
    return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(pageName)}`
  } catch {
    return null
  }
}

// Builds Wikipedia contributions URL from edit URL. Returns null if URL is malformed.
function getUserContributionsUrl(editUrl, username) {
  try {
    const url = new URL(editUrl)
    const lang = url.hostname.split('.')[0]
    return `https://${lang}.wikipedia.org/wiki/Special:Contributions/${encodeURIComponent(username)}`
  } catch {
    return null
  }
}

function getStatus(edit, name, template) {
  const pageUrl = getArticleUrl(edit.url, edit.page)
  const userUrl = getUserContributionsUrl(edit.url, name)

  const text = Mustache.render(template, {
    name,
    url: edit.url,
    page: edit.page,
    count: edit.collapsedCount || 1
  })

  return {
    text,
    pageUrl,
    userUrl,
    page: edit.page,
    name
  }
}

/**
 * Resolve all consumers for an edit: config deliveries + subscriptions.
 *
 * Returns an array of consumers, each carrying its edit_filters.
 * Caches subscription lookup per edit (keyed by topicIds) to avoid duplicate queries.
 *
 * @param {Object} account - Account config
 * @param {Object} edit - Edit object (used for caching key)
 * @param {number[]} topicIds - Topic IDs to fetch subscriptions for
 * @returns {Promise<Array>} Array of consumers with edit_filters
 */
async function resolveConsumers(account, edit, topicIds = []) {
  const consumers = []

  // The account's own channels are for the account's own watchlist, decided
  // here (not by the caller) so no call path can forget it: an edit that only
  // a topic matched must reach only that topic's subscribers. This gate was
  // missing once and the account posted a Venezuela topic edit to its public
  // SF feeds.
  if (isWatched(account, edit)) {
    let configDeliveries = resolveConfigDeliveries(account)
    if (configDeliveries.length === 0) {
      // Warn and fall back to legacy per-stanza behavior
      console.warn('[resolveConsumers] account.deliveries is absent or empty - falling back to legacy per-stanza behavior')
      configDeliveries = []
      if (account.bluesky) {
        configDeliveries.push({ type: 'bluesky', credentials: account.bluesky })
      }
      if (account.mastodon) {
        configDeliveries.push({ type: 'mastodon', credentials: account.mastodon })
      }
      if (account.discord) {
        configDeliveries.push({ type: 'discord', credentials: account.discord })
      }
    }

    for (const delivery of configDeliveries) {
      consumers.push({
        type: 'config',
        subType: delivery.type,
        editFilters: delivery.edit_filters || null,
        delivery
      })
    }
  }

  // Load subscriptions for matched topics
  if (topicStore && topicIds.length > 0) {
    const seenSubscriptions = new Set()
    for (const topicId of topicIds) {
      try {
        const subs = await topicStore.subscriptionsForTopic(topicId)
        for (const sub of subs) {
          // Avoid duplicate subscriptions (one topic per subscription)
          if (!seenSubscriptions.has(sub.id)) {
            seenSubscriptions.add(sub.id)
            consumers.push({
              type: 'subscription',
              id: sub.id,
              editFilters: sub.editFilters || null,
              subscription: sub
            })
          }
        }
      } catch (error) {
        console.error(`Could not load subscriptions for topic ${topicId}:`, error.message)
      }
    }
  }

  return consumers
}

/**
 * Deliver an already-rendered post to the given subscriptions.
 * The render happened once, upstream; this is the cheap part.
 *
 * Handles rate-capping, health tracking, and quarantine of broken subscriptions.
 * Exported for testing.
 *
 * @param {Array} subscriptions - Flat list of subscription objects
 * @param {Object} payload - Rendered post payload { text, screenshot, metadata }
 * @returns {Promise<Array>} Delivery results
 */
async function deliverToTopics(subscriptions, payload) {
  if (!subscriptions || subscriptions.length === 0) return []

  const delivered = await deliverAll(subscriptions, payload,
    { limiter: subscriptionLimiter })

  for (const result of delivered) {
    if (result.capped) {
      console.log(`Subscription ${result.subscriptionId}: rate capped`)
      continue
    }
    if (result.ok) {
      subscriptionHealth.record(result.subscriptionId, result)
      continue
    }

    console.error(
      `Subscription ${result.subscriptionId} delivery failed: ${result.error}`)

    if (subscriptionHealth.record(result.subscriptionId, result)) {
      try {
        if (topicStore) {
          await topicStore.setSubscriptionStatus(result.subscriptionId, 'broken')
          console.error(
            `Subscription ${result.subscriptionId} quarantined after repeated ` +
            'permanent failures; it will stop receiving posts')
        }
      } catch (error) {
        console.error(
          `Could not quarantine subscription ${result.subscriptionId}:`, error.message)
      }
    }
  }
  return delivered
}

/** How a consumer is named in filtered:/filter-pass: log lines. */
function consumerLabel(consumer) {
  return consumer.type === 'subscription' ? `sub:${consumer.id}` : consumer.subType
}

/**
 * Post an edit to all configured platforms and matching topic subscriptions.
 *
 * @param {Object} [thread] - Optional thread refs from earlier posts in an
 *   edit burst: { root, parent }, each { bluesky: {uri, cid}|null,
 *   mastodon: <status id>|null }. When present, Bluesky and Mastodon posts
 *   are created as replies so a burst reads as one thread. Discord posts via
 *   webhook, which cannot reply, so collapsed posts stand alone there.
 * @returns {Object|null} Refs of the posts just made (same per-platform
 *   shape), or null if nothing was posted (noop mode, blocked, or all
 *   platforms failed).
 */
async function sendStatus(account, statusData, edit, topicIds = [], thread = null) {
  try {
    console.log(statusData.text)

    // Resolve all consumers (config deliveries + subscriptions) and run metadata filtering
    const consumers = await resolveConsumers(account, edit, topicIds)

    // METADATA STAGE: filter by stream-level properties before fetch/render.
    // Drops log here; survivors log once, at the point they are finally
    // confirmed (below for noop, after the content stage otherwise), so
    // `grep -c filter-pass` counts each delivered consumer exactly once.
    const metadataFiltered = []
    for (const consumer of consumers) {
      if (passesMetadata(edit, consumer.editFilters)) {
        metadataFiltered.push(consumer)
      } else {
        const reason = metadataDropReason(edit, consumer.editFilters)
        console.log(`filtered: ${edit.page} for ${consumerLabel(consumer)} (${reason})`)
      }
    }

    // SIGNIFICANCE STAGE: classify "did this edit change what a reader sees?"
    // once per edit if any consumer opted in ('log' or true). Runs before the
    // --noop return (verdicts observable in no-post runs) and before the diff
    // fetch (dropped edits skip diff/image work). Conservative pass on any
    // failure — see lib/significance-stage.js tests.
    const consumersAfterSignificance = await filterBySignificance(edit, metadataFiltered, {
      label: consumerLabel
    })

    if (argv.noop) {
      // Noop stops before the diff fetch, so significance-filtered survivors are final here.
      for (const consumer of consumersAfterSignificance) {
        console.log(`filter-pass: ${edit.page} for ${consumerLabel(consumer)}`)
      }
      return null
    }

    {
      // Early return if no consumers survived significance filtering
      if (consumersAfterSignificance.length === 0) {
        return null
      }

      // Fetch the diff once; reused for page verification and content filtering
      const diffHtml = await fetchDiffHtml(edit.url)

      // Guard against the IRC feed parser splicing a stale page title onto a
      // different edit's URL. Confirm the diff actually belongs to edit.page.
      const verification = verifyDiffPage(diffHtml, edit.page)
      if (!verification.match) {
        console.error(`Post blocked: diff is for "${verification.actualPage}", not "${edit.page}"`)
        return null
      }

      // CONTENT STAGE: filter by cosmetic-only if any consumer needs it
      let consumersAfterContent = consumersAfterSignificance
      const anyNeedsContentCheck = consumersAfterSignificance.some(c => needsContentCheck(c.editFilters))
      if (anyNeedsContentCheck && isCosmeticOnly(diffHtml)) {
        consumersAfterContent = []
        for (const consumer of consumersAfterSignificance) {
          if (!needsContentCheck(consumer.editFilters)) {
            consumersAfterContent.push(consumer)
          } else {
            console.log(`filtered: ${edit.page} for ${consumerLabel(consumer)} (cosmetic_only)`)
          }
        }
      }

      // Survivors are final past this point — the single filter-pass log site.
      for (const consumer of consumersAfterContent) {
        console.log(`filter-pass: ${edit.page} for ${consumerLabel(consumer)}`)
      }

      // Early return if no consumers remain after content filtering
      if (consumersAfterContent.length === 0) {
        return null
      }

      // Enrich IP addresses with country flags
      const enrichedText = await enrichIPsInText(statusData.text)

      // Render diff via compare API (falls back to page screenshot)
      const capture = await captureDiffImage(edit.url, edit.page)

      if (!capture) {
        throw new Error('Failed to capture screenshot')
      }
      const screenshot = capture.screenshot

      try {
        // Prepare metadata for posting
        const metadata = {
          page: edit.page,
          name: statusData.name,
          pageUrl: statusData.pageUrl,
          userUrl: statusData.userUrl,
          diffUrl: edit.url,
          wiki: edit.wikipedia,
          altText: capture.altText,
          summary: capture.summary,
          article: capture.article
        }

        // Build the refs object for threading and track all delivery results
        const refs = { bluesky: null, mastodon: null }
        const deliveryResults = []

        // Post to each config delivery target independently so one failing doesn't
        // stop the others, and so thread refs survive partial failures.
        for (const consumer of consumersAfterContent) {
          if (consumer.type !== 'config') continue

          const delivery = consumer.delivery
          try {
            // CRITICAL 4: Delivery-level template override
            let deliveryText = enrichedText
            // Skip override for collapsed posts: delivery overrides often omit {{count}},
            // which would lose the burst summary (e.g., "edited 5 times" becomes "edited 1 time")
            const isCollapsedBurst = (edit.collapsedCount || 1) > 1
            if (delivery.template && !isCollapsedBurst) {
              const overrideStatus = getStatus(edit, edit.user, delivery.template)
              deliveryText = await enrichIPsInText(overrideStatus.text)
            }

            // Prepare platform-specific replyTo if threading is needed
            let replyTo = null
            if (thread && thread.parent) {
              if (delivery.type === 'bluesky' && thread.parent.bluesky) {
                // Bluesky replies need both root and parent refs
                replyTo = {
                  root: (thread.root && thread.root.bluesky) || thread.parent.bluesky,
                  parent: thread.parent.bluesky
                }
              } else if (delivery.type === 'mastodon' && thread.parent.mastodon) {
                // Mastodon reply is just the status id
                replyTo = thread.parent.mastodon
              }
              // Discord webhooks don't support threading
            }

            // Post to this delivery target
            const result = await deliveryPost(delivery, {
              text: deliveryText,
              screenshot,
              metadata,
              replyTo
            })

            // Handle validation rejection (null result)
            if (!result) {
              console.warn(`[sendStatus] ${delivery.type} post was rejected (allowlist or validation failure)`)
              continue
            }

            deliveryResults.push(result)

            // Update refs object for threading follow-ups
            if (result.type === 'bluesky') {
              refs.bluesky = result.ref
            } else if (result.type === 'mastodon') {
              refs.mastodon = result.ref
            }

            console.log(`[sendStatus] Posted to ${result.type} (${result.postId})`)
          } catch (error) {
            console.error(`${delivery.type} post failed:`, error.message)
          }
        }

        // Filter subscriptions from consumersAfterContent and deliver to them
        const subscriptionsToDeliver = consumersAfterContent
          .filter(c => c.type === 'subscription')
          .map(c => c.subscription)

        // Fan out to subscriptions, reusing the single render above.
        // deliverToTopics handles rate-capping, health tracking, and quarantine.
        const subscriptionResults = await deliverToTopics(subscriptionsToDeliver, {
          text: enrichedText,
          screenshot,
          metadata
        })

        // Record what was posted so the revdel sweeper can delete these
        // posts if the revision is later hidden on-wiki. A collapsed post
        // publicizes every buffered revision, so record it under each one:
        // hiding ANY constituent revision must take the combined post down.
        const allDeliveries = [
          ...deliveryResults,
          ...subscriptionResults
            .filter(r => r.ok)
            .map(r => ({ type: r.type, postId: r.postId, subscriptionId: r.subscriptionId }))
        ]

        // CRITICAL 2+3: Total failure case (no successful deliveries)
        // If allDeliveries is empty, no post succeeded - don't write heartbeat or entry
        if (allDeliveries.length === 0) {
          console.warn('[sendStatus] All deliveries failed - no post recorded, no heartbeat written')
          return null
        }

        const recordUrls = edit.collapsedUrls || [edit.url]
        for (const diffUrl of recordUrls) {
          recordPost({ diffUrl, page: edit.page, deliveries: allDeliveries })
        }
        writeHeartbeat('post')
        return refs
      } finally {
        // Always clean up screenshot, even if posting fails
        if (screenshot && fs.existsSync(screenshot)) {
          fs.unlinkSync(screenshot)
        }
      }
    }
    return null
  } catch (error) {
    console.error('Posting failed:', error)
    return null
  }
}

const DEFAULT_COLLAPSE_TEMPLATE = '{{{page}}} Wikipedia article edited {{count}} times by {{{name}}} {{&url}}'

async function postEdit(account, edit, count, thread) {
  const template = count > 1
    ? (account.collapse && account.collapse.template) || DEFAULT_COLLAPSE_TEMPLATE
    : account.template
  const statusData = getStatus(edit, edit.user, template)
  // Topic membership is recomputed at post time: for a combined edit the
  // page is unchanged, and this picks up index refreshes during the window.
  const topicIds = topicIndex ? topicIndex.topicsForEdit(edit) : []
  try {
    return await sendStatus(account, statusData, edit, topicIds, thread)
  } catch (error) {
    console.error('Failed to process edit:', edit.page, error.message)
    return null
  }
}

// One collapser per account, created lazily so tests can call inspect()
// with ad-hoc account objects.
const collapsers = new Map()

function getCollapser(account) {
  let collapser = collapsers.get(account)
  if (!collapser) {
    const cfg = account.collapse || {}
    const windowMinutes = cfg.window_minutes || DEFAULT_WINDOW_MINUTES
    collapser = new EditCollapser({
      windowMs: windowMinutes * 60 * 1000,
      postEdit: (edit, count, thread) => {
        if (count > 1) {
          console.log(`Collapsed ${count} edits to "${edit.page}" by ${edit.user} into one post`)
        }
        // Returns post refs so follow-up posts in the burst thread under
        // the first one; postEdit resolves to null on failure/block.
        return postEdit(account, edit, count, thread)
      }
    })
    collapsers.set(account, collapser)
  }
  return collapser
}

async function inspect(account, edit) {
  // Wikidata edits are claim-watched (statement-level semantics), not
  // page-watched; only accounts with a wikidata_claims stanza divert here
  if (edit.wikipedia === 'Wikidata' && account.claimWatch) {
    return handleWikidataEdit(account, edit, {
      sets: account.claimWatch.sets,
      rateCap: account.claimWatch.rateCap,
      noop: Boolean(argv.noop)
    }).catch(error => console.error('Claim-watch error:', error.message))
  }

  if (edit.url) {
    // Two independent membership sources. The legacy PageAssessments
    // watchlist is what the SFBA bot runs on and is deliberately left
    // untouched; the topic index is the new platform path. An edit matching
    // both is rendered once and delivered to both.
    const watched = isWatched(account, edit)
    const topicIds = topicIndex ? topicIndex.topicsForEdit(edit) : []

    if (watched || topicIds.length > 0) {
      if (account.collapse && account.collapse.enabled === false) {
        await postEdit(account, edit, 1, null)
      } else {
        const result = getCollapser(account).add(edit)
        if (result.action === 'buffered') {
          console.log(`Buffered edit to "${edit.page}" by ${edit.user} (${result.pending} pending in collapse window)`)
        }
      }
    }
  }
}

function checkConfig(config, error) {
  if (config.accounts) {
    return async.each(config.accounts, (account, callback) => callback(), error)
  } else {
    return error("missing accounts stanza in config")
  }
}

// The live EventStreams connection, kept module-level so shutdown can close it
// rather than leaving the stream for Wikimedia to time out.
let editStream = null

/**
 * Release what a restart would otherwise sever mid-flight: the SSE connection
 * and the database pool.
 *
 * Buffered edits get one best-effort flush rather than being dropped, which is
 * what EditCollapser.flushAll is for. Those posts are fire-and-forget, so a
 * flush that outruns the shutdown grace period is cut off — same outcome as the
 * drop it replaces, and the log line says how many were in flight either way.
 */
async function shutdownCleanly() {
  const pending = Array.from(collapsers.values())
    .reduce((total, collapser) => total + collapser.pendingCount(), 0)
  if (pending > 0) {
    console.log(`Flushing ${pending} buffered edit(s) still inside a collapse window`)
    for (const collapser of collapsers.values()) {
      collapser.flushAll()
    }
  }

  if (editStream) {
    editStream.stop()
    editStream = null
  }

  if (topicStore) {
    try {
      await topicStore.close()
    } catch (error) {
      console.error('Could not close the topic store:', error.message)
    }
    topicStore = null
  }
}

async function main() {
  const config = getConfig()

  // Initialize geolocation database before listening for edits
  await initializeReader()

  // Fetch dynamic article lists (WikiProject task forces) before listening
  await startWatchlistSync(config, { dataDir: HEARTBEAT_DIR })

  // Topic store: optional. Without a topic_store stanza the bot behaves
  // exactly as it did before the platform work, running on the account
  // watchlists alone.
  if (config.topic_store) {
    topicStore = createTopicStore({ config: config.topic_store })
    topicIndex = createTopicIndex(topicStore)
    subscriptionLimiter = new SubscriptionLimiter({
      max: config.topic_store.max_posts_per_hour || undefined,
      windowMs: config.topic_store.rate_window_ms || undefined
    })
    // Idle caps accumulate as subscriptions come and go; sweep hourly.
    const pruneTimer = setInterval(() => subscriptionLimiter.prune(), 60 * 60 * 1000)
    pruneTimer.unref()
    const loaded = await topicIndex.refresh()
    if (loaded.ok) {
      const stats = topicIndex.stats()
      console.log(
        `Topic index: ${stats.titleCount} titles across ${stats.topicCount} topics`)
      topicIndex.start()
    } else {
      console.error('Topic index unavailable at startup; account watchlists still active')
    }
  }

  // Build Bay Area target sets for Wikidata claim notices before listening
  await startClaimWatch(config, { dataDir: HEARTBEAT_DIR })

  return checkConfig(config, function (err) {
    if (!err) {
      // Periodically check posted revisions and delete posts whose
      // revision has been hidden/suppressed on-wiki
      if (!argv.noop && config.accounts.length > 0) {
        startSweeper(config.accounts[0], undefined, topicStore)
      }

      const wikipedia = new EditStream()
      editStream = wikipedia
      return wikipedia.listen(edit => {
        // Filename kept as 'irc' for healthcheck compatibility; the feed
        // is EventStreams now
        writeHeartbeat('irc')
        touchRun('bot')
        if (argv.verbose) {
          console.log(JSON.stringify(edit))
        }
        Array.from(config.accounts).forEach((account) => {
          inspect(account, edit).catch(error => console.error('Inspect error:', error))
        })
      })
    } else {
      return console.log(err)
    }
  })
}

if (require.main === module) {
  // Prevent unhandled errors from crashing the process
  process.on('uncaughtException', (error) => {
    console.error('Uncaught exception (continuing):', error)
  })
  process.on('unhandledRejection', (error) => {
    console.error('Unhandled rejection (continuing):', error)
  })

  // Every deploy ends with `toolforge jobs restart bot`, which stops the pod
  // with SIGTERM. Node running as PID 1 has no default handler for it, so
  // without this the process is SIGKILLed when the grace period expires and
  // the job emails out a bare "exit code 137 / reason 'Error'" for what was a
  // routine restart. Handling it exits 0 and says so; an unexplained 137 then
  // means something really did go wrong, and the next start explains what.
  installStopHandlers({ name: 'bot', cleanup: shutdownCleanly })

  console.log(`Starting sfedits bot (pid ${process.pid}, node ${process.version})`)
  console.log('Previous run:', explainPreviousRun(startRun('bot')))

  main().catch(error => {
    console.error('Fatal error:', error)
    process.exit(1)
  })
}

module.exports = {
  main,
  shutdownCleanly,
  getConfig,
  getStatus,
  getArticleUrl,
  getUserContributionsUrl,
  buildFacets,
  inspect,
  postEdit,
  sendStatus
}
module.exports.deliverToTopics = deliverToTopics
module.exports._setTopicStateForTest = (store, index) => {
  topicStore = store
  topicIndex = index
}
