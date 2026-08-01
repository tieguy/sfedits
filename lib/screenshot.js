const puppeteer = require('puppeteer')
const path = require('path')
const fs = require('fs')

const MAX_SCREENSHOT_HEIGHT = 5000
const DIFF_SELECTOR = 'table.diff.diff-type-table.diff-contentalign-left'
const LOG_FILE = path.join(__dirname, '..', 'data', 'screenshot-failures.log')
const MAX_LOG_BYTES = 1024 * 1024 // 1MB

const CHROME_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--single-process',
  '--no-zygote',
  '--font-render-hinting=none'
]

/**
 * Render an HTML string (our own diff rendering) and screenshot the
 * #diff container. Returns filename path or null if screenshot fails.
 */
async function takeHtmlScreenshot(html) {
  const filename = path.resolve(Date.now() + '.png')

  const browser = await puppeteer.launch({
    args: CHROME_ARGS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
    await page.setContent(html, { waitUntil: 'load', timeout: 30000 })

    const element = await page.$('#diff')
    if (!element) {
      logFailure('(rendered html)', 'element_not_found', '#diff container not found')
      return null
    }

    const box = await element.boundingBox()
    if (!box) {
      logFailure('(rendered html)', 'bounding_box_null', 'Bounding box is null')
      return null
    }

    const result = await captureScreenshot(page, filename, box)
    if (result) return filename

    logFailure('(rendered html)', 'capture_failed', `Screenshot of rendered diff failed (${Math.round(box.height)}px)`)
    return null
  } catch (error) {
    logFailure('(rendered html)', 'exception', error.message)
    return null
  } finally {
    await browser.close()
  }
}

/**
 * Take screenshot of Wikipedia diff
 * Tries full diff first; if capture fails, trims context rows and retries.
 * Returns filename path or null if screenshot fails.
 */
async function takeScreenshot(url) {
  const filename = path.resolve(Date.now() + '.png')

  const browser = await puppeteer.launch({
    args: CHROME_ARGS,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  })

  try {
    const page = await browser.newPage()
    await page.setViewport({ width: 1200, height: 800 })
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 30000 })

    const element = await page.$(DIFF_SELECTOR)
    if (!element) {
      logFailure(url, 'element_not_found', 'Diff table element not found')
      return null
    }

    const box = await element.boundingBox()
    if (!box) {
      logFailure(url, 'bounding_box_null', 'Bounding box is null')
      return null
    }

    // Trim rows that exceed MAX_SCREENSHOT_HEIGHT
    let clipBox = box
    if (box.height > MAX_SCREENSHOT_HEIGHT) {
      clipBox = await trimToMaxHeight(page, element)
      if (!clipBox) {
        logFailure(url, 'trim_height_failed', `Diff too tall (${Math.round(box.height)}px), trim failed`)
        return null
      }
    }

    // Try capturing the full diff
    const result = await captureScreenshot(page, filename, clipBox)
    if (result) return filename

    // Full capture failed - trim context rows and retry
    console.log('[takeScreenshot] Full capture failed, trimming context and retrying...')
    const trimmedBox = await trimContextRows(page, element)
    if (!trimmedBox) {
      logFailure(url, 'trim_context_failed', 'No content remained after trimming context rows')
      return null
    }

    const retryResult = await captureScreenshot(page, filename, trimmedBox)
    if (retryResult) return filename

    logFailure(url, 'capture_failed_after_trim', `Screenshot failed on both attempts (original: ${Math.round(clipBox.height)}px, trimmed: ${Math.round(trimmedBox.height)}px)`)
    return null
  } catch (error) {
    logFailure(url, 'exception', error.message)
    return null
  } finally {
    await browser.close()
  }
}

/**
 * Attempt a screenshot with dynamic viewport and captureBeyondViewport: false
 * Returns true on success, false on failure
 */
async function captureScreenshot(page, filename, clipBox) {
  try {
    await page.setViewport({
      width: 1200,
      height: Math.ceil(clipBox.y + clipBox.height)
    })
    await page.screenshot({
      path: filename,
      clip: clipBox,
      captureBeyondViewport: false
    })
    return true
  } catch (error) {
    console.error(`[takeScreenshot] Capture failed: ${error.message}`)
    return false
  }
}

/**
 * Remove context-only rows from the diff table, keeping 1 row of context
 * above and below each changed row. Returns new bounding box or null.
 */
async function trimContextRows(page, element) {
  await page.evaluate((selector) => {
    const table = document.querySelector(selector)
    if (!table) return

    const rows = Array.from(table.querySelectorAll('tr'))

    const isChange = rows.map(r =>
      r.querySelector('td.diff-addedline') !== null ||
      r.querySelector('td.diff-deletedline') !== null
    )

    const keep = rows.map((r, i) => {
      if (r.classList.contains('diff-title')) return true
      if (r.querySelector('td.diff-lineno')) return true
      if (isChange[i]) return true
      if (i > 0 && isChange[i - 1]) return true
      if (i < rows.length - 1 && isChange[i + 1]) return true
      return false
    })

    rows.forEach((r, i) => { if (!keep[i]) r.remove() })
  }, DIFF_SELECTOR)

  const box = await element.boundingBox()
  return box && box.height > 0 ? box : null
}

/**
 * Trim rows that push the diff beyond MAX_SCREENSHOT_HEIGHT
 * Returns new bounding box or null.
 */
async function trimToMaxHeight(page, element) {
  await page.evaluate((selector, maxH) => {
    const table = document.querySelector(selector)
    if (!table) return
    const tableTop = table.getBoundingClientRect().top
    const rows = table.querySelectorAll('tr')
    let removing = false
    for (const row of rows) {
      if (removing) {
        row.remove()
        continue
      }
      const rowBottom = row.getBoundingClientRect().bottom - tableTop
      if (rowBottom > maxH) {
        removing = true
        row.remove()
      }
    }
  }, DIFF_SELECTOR, MAX_SCREENSHOT_HEIGHT)

  const box = await element.boundingBox()
  return box && box.height > 0 ? box : null
}

/**
 * Log screenshot failure to data/screenshot-failures.log
 */
function logFailure(url, reason, details) {
  console.error(`[takeScreenshot] Failed: ${reason} - ${details}`)

  const entry = {
    timestamp: new Date().toISOString(),
    url,
    reason,
    details
  }

  try {
    trimLogIfNeeded()
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
  } catch (err) {
    console.error('[takeScreenshot] Failed to write log:', err.message)
  }
}

function trimLogIfNeeded() {
  try {
    const stat = fs.statSync(LOG_FILE)
    if (stat.size < MAX_LOG_BYTES) return
    const lines = fs.readFileSync(LOG_FILE, 'utf8').split('\n').filter(Boolean)
    const keep = lines.slice(Math.floor(lines.length / 2))
    fs.writeFileSync(LOG_FILE, keep.join('\n') + '\n')
  } catch (err) {
    if (err.code === 'ENOENT') return
  }
}

module.exports = {
  takeScreenshot,
  takeHtmlScreenshot
}
