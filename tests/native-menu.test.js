import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'
import { transformSync } from 'esbuild'

const require = createRequire(new URL('../src/client/index.jsx', import.meta.url))
const source = readFileSync(new URL('../src/client/index.jsx', import.meta.url), 'utf8')
const { code } = transformSync(source + '\nexport { installSidebarSessionMenuAug };', { loader: 'jsx', format: 'cjs' })

function load() {
  const module = { exports: {} }
  const timers = new Map()
  let seq = 0
  runInNewContext(code, {
    module, exports: module.exports, require, console,
    document: { addEventListener() {}, removeEventListener() {}, querySelectorAll: () => [] },
    fetch: async () => ({ ok: true, json: async () => ({ items: [] }) }),
    setInterval(fn) { timers.set(++seq, fn); return seq },
    clearInterval(id) { timers.delete(id) },
    setTimeout, clearTimeout,
  })
  return { install: module.exports.installSidebarSessionMenuAug, timers }
}

test('native session menus register once, resolve synchronously and cleanly reattach', () => {
  const { install } = load()
  const entries = new Map(), cleanups = []
  const ctx = {
    get: () => ({ register(entry) { assert.ok(!entries.has(entry.id)); entries.set(entry.id, entry); return () => entries.delete(entry.id) } }),
    effect(fn) { cleanups.push(fn()) },
  }
  const hub = { on() { assert.fail('native menus must not subscribe to portal DOM') } }
  const stop = install(ctx, hub)
  assert.equal(entries.size, 3)
  assert.equal(install(ctx, hub), undefined)
  for (const entry of entries.values()) {
    const resolved = entry.resolve({ sessionId: 'test-session' })
    assert.ok(Array.isArray(resolved), 'menu resolution must stay within the host time budget')
    assert.equal(resolved.length, 1)
  }
  stop()
  for (const cleanup of cleanups.splice(0)) cleanup()
  const stopAgain = install(ctx, hub)
  assert.equal(entries.size, 3)
  stopAgain()
  for (const cleanup of cleanups) cleanup()
  assert.equal(entries.size, 0)
})

test('late native menu service withdraws the shared portal subscription', () => {
  const { install, timers } = load()
  let service, subscribed = 0
  const cleanups = []
  const ctx = { get: () => service, effect(fn) { cleanups.push(fn()) } }
  const stop = install(ctx, { on(event) { assert.equal(event, 'portal'); subscribed++; return () => { subscribed = 0 } } })
  assert.equal(subscribed, 1)
  assert.equal(timers.size, 1)
  const registered = new Map()
  service = { register(entry) { registered.set(entry.id, entry); return () => registered.delete(entry.id) } }
  for (const tick of timers.values()) tick()
  assert.equal(subscribed, 0)
  assert.equal(timers.size, 0)
  assert.equal(registered.size, 3)
  stop()
  for (const cleanup of cleanups) cleanup()
  assert.equal(registered.size, 0)
})
