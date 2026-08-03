/**
 * Collapses bursts of edits into fewer posts.
 *
 * When someone does an intense editing session on a watched page, posting
 * every revision floods the feed. The collapser posts the first edit in a
 * burst immediately, then buffers any further edits to the same page by the
 * same editor. When the collapse window closes, the whole buffer is flushed
 * as a single combined edit whose diff URL spans every buffered revision.
 * If the burst is still going when a window closes, a fresh window opens so
 * sustained activity produces at most one post per window.
 *
 * Buffers live in memory only: a restart drops any pending (unposted)
 * buffered edits, which matches the bot's existing at-most-once posting
 * behavior.
 */

const DEFAULT_WINDOW_MINUTES = 15

/**
 * Build a single diff URL spanning several consecutive edits.
 *
 * Wikipedia diff URLs look like /w/index.php?diff=NEW&oldid=OLD. The first
 * buffered edit's oldid is the revision the burst started from, and the last
 * edit's diff is the newest revision, so combining them yields one diff page
 * showing the net change.
 *
 * @param {string} firstUrl - Diff URL of the oldest buffered edit
 * @param {string} lastUrl - Diff URL of the newest buffered edit
 * @returns {string|null} - Combined diff URL, or null if either URL is unusable
 */
function combineDiffUrls(firstUrl, lastUrl) {
  try {
    const first = new URL(firstUrl)
    const last = new URL(lastUrl)
    const oldid = first.searchParams.get('oldid')
    const diff = last.searchParams.get('diff')
    if (!oldid || !diff) {
      return null
    }
    const combined = new URL(last.origin + last.pathname)
    combined.searchParams.set('diff', diff)
    combined.searchParams.set('oldid', oldid)
    return combined.toString()
  } catch {
    return null
  }
}

class EditCollapser {
  /**
   * @param {Object} options
   * @param {number} [options.windowMs] - Collapse window length in milliseconds
   * @param {function(Object, number, Object|null): (Object|Promise<Object|null>|void)} options.postEdit
   *   Called with (edit, count, thread). count === 1 means a lone edit;
   *   count > 1 means edit is a combined edit covering that many revisions
   *   (with edit.collapsedCount set). thread is null for the first post in a
   *   burst, or { root, parent } refs of earlier posts in the burst so the
   *   caller can post follow-ups as replies. May return (a promise of) the
   *   new post's refs; falsy means nothing was posted.
   */
  constructor({ windowMs = DEFAULT_WINDOW_MINUTES * 60 * 1000, postEdit }) {
    this.windowMs = windowMs
    this.postEdit = postEdit
    this.windows = new Map()
  }

  keyFor(edit) {
    return `${edit.wikipedia}|${edit.page}|${edit.user}`
  }

  /**
   * Feed an edit through the collapser. The first edit for a quiet
   * page/editor posts immediately and opens a window; edits arriving while a
   * window is open are buffered until the window closes.
   */
  add(edit) {
    const key = this.keyFor(edit)
    const win = this.windows.get(key)
    if (win) {
      win.buffer.push(edit)
      return { action: 'buffered', pending: win.buffer.length }
    }
    // Kick off the leading post right away and remember its refs (as a
    // promise) so the window's eventual combined post can thread under it.
    let leadingPost
    try {
      leadingPost = this.postEdit(edit, 1, null)
    } catch {
      leadingPost = null
    }
    const thread = Promise.resolve(leadingPost)
      .then(refs => (refs ? { root: refs, parent: refs } : null))
      .catch(() => null)
    this.openWindow(key, thread)
    return { action: 'posted' }
  }

  openWindow(key, thread = null) {
    const timer = setTimeout(() => this.flush(key), this.windowMs)
    // Don't keep the process alive just for an idle collapse window
    if (timer.unref) {
      timer.unref()
    }
    this.windows.set(key, { buffer: [], timer, thread })
  }

  /**
   * Close the window for a key. An empty buffer just closes quietly; a
   * non-empty buffer posts one combined edit and reopens the window so an
   * ongoing burst keeps collapsing instead of reverting to per-edit posts.
   * Thread refs carry across reopened windows: the root stays the burst's
   * first post, the parent advances to the latest post that succeeded.
   */
  flush(key) {
    const win = this.windows.get(key)
    if (!win) {
      return
    }
    clearTimeout(win.timer)
    this.windows.delete(key)
    if (win.buffer.length === 0) {
      return
    }
    const combined = this.combine(win.buffer)
    const count = win.buffer.length
    const nextThread = Promise.resolve(win.thread)
      .then(async thread => {
        const refs = await this.postEdit(combined, count, thread)
        if (!refs) {
          // Nothing posted (blocked/failed): keep threading under the last
          // post that did go out.
          return thread
        }
        return { root: thread ? thread.root : refs, parent: refs }
      })
      .catch(() => null)
    this.openWindow(key, nextThread)
  }

  combine(buffer) {
    const first = buffer[0]
    const last = buffer[buffer.length - 1]
    const combined = Object.assign({}, last)
    combined.collapsedCount = buffer.length

    // Aggregate delta: sum of all deltas (treating null as 0).
    // If every delta is null, result is null (conservative: unknown size).
    const hasAnyNonNull = buffer.some(e => e.delta !== null && e.delta !== undefined)
    if (hasAnyNonNull) {
      combined.delta = buffer.reduce((sum, e) => sum + (e.delta ?? 0), 0)
    } else {
      // All nulls: keep null (unknown size)
      combined.delta = null
    }

    // Aggregate robot: true only if every constituent was true
    combined.robot = buffer.every(e => e.robot)

    // Aggregate minor: true only if every constituent was true
    combined.minor = buffer.every(e => e.minor)

    // Every constituent diff URL, so the caller can log the combined post
    // against each buffered revision (e.g. for revdel takedowns).
    combined.collapsedUrls = buffer.map(e => e.url)
    const url = combineDiffUrls(first.url, last.url)
    if (url) {
      combined.url = url
    }
    return combined
  }

  /** Flush every open window immediately (useful for shutdown and tests). */
  flushAll() {
    for (const key of Array.from(this.windows.keys())) {
      this.flush(key)
    }
  }
}

module.exports = { EditCollapser, combineDiffUrls, DEFAULT_WINDOW_MINUTES }
