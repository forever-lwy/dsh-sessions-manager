import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installSessionSync, shouldHideEmptySession } from '../src/client/session-sync.js'

function setup() {
  let snapshot = { ids: ['a'], byId: { a: { id: 'a', blank: true, running: false, updatedAt: 1 } } }
  const subscribers = new Set(), events = new Map(), timers = new Map(), visibility = new Set()
  let nextTimer = 0, refreshes = 0, sidebars = 0
  let sidebarRead = async () => {}
  const doc = {
    hidden: false,
    addEventListener: (_, fn) => visibility.add(fn),
    removeEventListener: (_, fn) => visibility.delete(fn),
  }
  const stop = installSessionSync({
    sessions: {
      list: { getSnapshot: () => snapshot, subscribe: fn => { subscribers.add(fn); return () => subscribers.delete(fn) } },
      refresh: async () => { refreshes++ },
    },
    remote: { $on: (name, fn) => { events.set(name, fn); return () => events.delete(name) } },
    document: doc,
    refreshSidebar: async () => { sidebars++; await sidebarRead() },
    setTimeout: fn => { timers.set(++nextTimer, fn); return nextTimer },
    clearTimeout: id => timers.delete(id),
  })
  return {
    stop, doc, events, timers, subscribers, visibility,
    counts: () => ({ refreshes, sidebars }),
    setRead(fn) { sidebarRead = fn },
    update(row) {
      snapshot = row ? { ids: ['a'], byId: { a: { id: 'a', ...row } } } : { ids: [], byId: {} }
      for (const fn of subscribers) fn()
    },
    async flush() { const tasks = [...timers.values()]; timers.clear(); await Promise.all(tasks.map(fn => fn())) },
  }
}

test('new session acceptance refreshes sidebar state in one debounce, without waiting for completion', async () => {
  const h = setup()
  await h.flush()
  h.update({ blank: false, running: true, updatedAt: 2 })
  h.events.get('api-session/activity')('a', 2)
  h.events.get('api-session/status')('a', true)
  assert.equal(h.timers.size, 1, 'burst of acceptance events coalesces')
  await h.flush()
  assert.deepEqual(h.counts(), { refreshes: 0, sidebars: 2 })
  h.stop()
})

test('token and projection updates do not request whole-list or sidebar reads', async () => {
  const h = setup()
  h.update({ blank: false, running: true, updatedAt: 2, title: 'Question' })
  await h.flush()
  for (let token = 0; token < 200; token++) {
    h.update({ blank: false, running: true, updatedAt: 2, title: 'Question', projectionValues: { token } })
  }
  assert.equal(h.timers.size, 0)
  assert.deepEqual(h.counts(), { refreshes: 0, sidebars: 1 })
  h.stop()
})

test('live instance disposal repairs the persisted catalog instead of losing the row', async () => {
  const h = setup()
  await h.flush()
  h.update(null)
  h.events.get('api-session/removed')('a')
  await h.flush()
  assert.deepEqual(h.counts(), { refreshes: 1, sidebars: 2 })
  h.stop()
})

test('an activity received before its catalog row pulls a fresh baseline', async () => {
  const h = setup()
  await h.flush()
  h.events.get('api-session/activity')('not-listed-yet', 2)
  await h.flush()
  assert.equal(h.counts().refreshes, 1)
  h.stop()
})

test('a restoration finishing during an in-flight read gets a trailing refresh', async () => {
  const h = setup()
  let release
  h.setRead(() => new Promise(resolve => { release = resolve }))
  const reading = h.flush()
  h.events.get('api-session/activity')('a', 2)
  h.events.get('api-session/activity')('a', 2)
  assert.equal(h.timers.size, 0, 'no overlapping read')
  h.setRead(async () => {})
  release()
  await reading
  assert.equal(h.timers.size, 1)
  await h.flush()
  assert.equal(h.counts().sidebars, 2)
  h.stop()
})

test('background tabs defer work, visibility repairs the baseline, and disposal releases listeners', async () => {
  const h = setup()
  await h.flush()
  h.doc.hidden = true
  h.update({ blank: false, running: true, updatedAt: 2 })
  assert.equal(h.timers.size, 0)
  h.doc.hidden = false
  for (const fn of h.visibility) fn()
  await h.flush()
  assert.equal(h.counts().refreshes, 1)
  h.events.get('api-session/activity')('a', 2)
  h.stop()
  assert.equal(h.timers.size, 0)
  assert.equal(h.events.size, 0)
  assert.equal(h.subscribers.size, 0)
  assert.equal(h.visibility.size, 0)
})

test('stale empty scans never hide current drafts, accepted prompts, or running sessions', () => {
  const empty = { empty: true }
  assert.equal(shouldHideEmptySession(empty, { blank: true }, true), false)
  assert.equal(shouldHideEmptySession(empty, { blank: false }), false)
  assert.equal(shouldHideEmptySession(empty, { blank: true, running: true }), false)
  assert.equal(shouldHideEmptySession(empty, { blank: true }), true)
  assert.equal(shouldHideEmptySession(empty, undefined), true, 'legacy empty scan still works')
  assert.equal(shouldHideEmptySession(null, { blank: true }), false)
})
