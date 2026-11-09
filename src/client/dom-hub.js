/**
 * One shared DOM watch for every sidebar shim (fork: forever-lwy).
 *
 * The client used to run four whole-document MutationObservers, one of them
 * with `attributes` and `characterData` on all of <body>. While a reply
 * streams, every token then woke the sidebar painter. The hub replaces them:
 *
 * - one <body> observer with `childList` + `subtree` only. Its callback only
 *   classifies records: a change directly under <body> is a portal (menus,
 *   dialogs); a change inside an open dialog is dialog work; anything else
 *   (the conversation stream) schedules nothing;
 * - one observer scoped to the sidebar session tree(s), with the attributes
 *   and text the status painter needs. It re-attaches when the tree remounts.
 *
 * Subscribers run at most once per animation frame, grouped by kind:
 *   'portal'  – direct children of <body> changed
 *   'dialog'  – a dialog appeared, vanished, or changed inside
 *   'sidebar' – the session tree changed or was (re)mounted
 */

const SIDEBAR_ATTRS = ['data-state', 'aria-selected', 'class', 'style']
const TREE_SELECTOR = '[role="tree"]'
const TREE_CONTENT = '[data-row-key^="session:"],[data-row-key^="workspace:"]'

export function createDomHub(options = {}) {
  const doc = options.document || document
  const Observer = options.MutationObserver || MutationObserver
  const raf = options.requestAnimationFrame || ((fn) => requestAnimationFrame(fn))
  const caf = options.cancelAnimationFrame || ((id) => cancelAnimationFrame(id))

  const listeners = { portal: new Set(), dialog: new Set(), sidebar: new Set() }
  const pending = { portal: false, dialog: false, sidebar: false, retree: true }
  let trees = []
  let dialogs = []
  let frame = 0
  let disposed = false

  const findTrees = () => [...doc.querySelectorAll(TREE_SELECTOR)].filter((t) => t.querySelector(TREE_CONTENT))
  const findDialogs = () => [...doc.querySelectorAll('[role="dialog"]')]
  const inside = (list, node) => {
    for (const el of list) if (el === node || el.contains(node)) return true
    return false
  }
  const treesConnected = () => trees.length > 0 && trees.every((t) => t.isConnected)

  const treeObserver = new Observer(() => {
    pending.sidebar = true
    schedule()
  })

  const attachTrees = () => {
    const next = findTrees()
    if (next.length === trees.length && next.every((t, i) => t === trees[i])) return false
    treeObserver.disconnect()
    for (const t of next) {
      treeObserver.observe(t, { childList: true, subtree: true, attributes: true, attributeFilter: SIDEBAR_ATTRS, characterData: true })
    }
    trees = next
    return true
  }

  const emit = (kind) => {
    for (const fn of [...listeners[kind]]) {
      try { fn() } catch (e) { /* one shim's failure must not starve the others */ }
    }
  }

  const flush = () => {
    frame = 0
    if (disposed) return
    if (pending.retree) {
      pending.retree = false
      if (attachTrees()) pending.sidebar = true
    }
    if (pending.portal) {
      const next = findDialogs()
      if (next.length !== dialogs.length || next.some((d, i) => d !== dialogs[i])) pending.dialog = true
      dialogs = next
    }
    const run = { portal: pending.portal, dialog: pending.dialog, sidebar: pending.sidebar }
    pending.portal = pending.dialog = pending.sidebar = false
    if (run.portal) emit('portal')
    if (run.dialog) emit('dialog')
    if (run.sidebar) emit('sidebar')
  }

  function schedule() {
    if (!frame && !disposed) frame = raf(flush)
  }

  const bodyObserver = new Observer((records) => {
    let hit = false
    const connected = treesConnected()
    for (const r of records) {
      const t = r.target
      if (t === doc.body) {
        pending.portal = true
        hit = true
      } else if (dialogs.length && inside(dialogs, t)) {
        pending.dialog = true
        hit = true
      }
    }
    // The tree vanished (sidebar collapsed / remounted) or has not been seen
    // yet: look for it again on the next frame. Changes inside a live tree are
    // the tree observer's job.
    if (!connected) {
      pending.retree = true
      hit = true
    }
    if (hit) schedule()
  })

  return {
    start() {
      if (disposed || !doc.body) return
      bodyObserver.observe(doc.body, { childList: true, subtree: true })
      pending.portal = pending.dialog = pending.retree = true
      schedule()
    },
    /** Subscribe to one kind of change; returns the unsubscribe function. */
    on(kind, fn) {
      listeners[kind].add(fn)
      return () => listeners[kind].delete(fn)
    },
    /** Ask for a 'sidebar' run on the next frame (e.g. after a data refresh). */
    touchSidebar() {
      pending.sidebar = true
      schedule()
    },
    get trees() { return trees },
    dispose() {
      disposed = true
      if (frame) caf(frame)
      frame = 0
      bodyObserver.disconnect()
      treeObserver.disconnect()
      for (const set of Object.values(listeners)) set.clear()
    },
  }
}
