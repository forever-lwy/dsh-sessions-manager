import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDomHub } from '../src/client/dom-hub.js'

// Minimal DOM: elements with parent links, attributes, contains/isConnected
// and the two selectors the hub uses.
class El {
  constructor(attrs = {}) { this.attrs = attrs; this.children = []; this.parent = null }
  append(...kids) { for (const k of kids) { k.parent = this; this.children.push(k) } return this }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null }
  contains(n) { for (let e = n; e; e = e.parent) if (e === this) return true; return false }
  get isConnected() { let e = this; while (e.parent) e = e.parent; return e === doc.root }
  *walk() { for (const c of this.children) { yield c; yield* c.walk() } }
  matches(sel) {
    if (sel === '[role="tree"]') return this.attrs.role === 'tree'
    if (sel === '[role="dialog"]') return this.attrs.role === 'dialog'
    return sel.split(',').some((s) => { const m = /data-row-key\^="([^"]+)"/.exec(s); return m && String(this.attrs['data-row-key'] || '').startsWith(m[1]) })
  }
  querySelectorAll(sel) { return [...this.walk()].filter((e) => e.matches(sel)) }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null }
}
let doc
function setup() {
  const root = new El(); const body = new El(); root.append(body)
  doc = { root, body, querySelectorAll: (s) => root.querySelectorAll(s) }
  const observers = []
  class FakeObserver {
    constructor(cb) { this.cb = cb; this.targets = []; observers.push(this) }
    observe(target, opts) { this.targets.push({ target, opts }) }
    disconnect() { this.targets = [] }
  }
  // Deliver a mutation to every observer watching an ancestor of `target`.
  const mutate = (target, extra = {}) => {
    for (const o of observers) {
      const hit = o.targets.find((t) => t.target === target || (t.opts.subtree && t.target.contains(target)))
      if (!hit) continue
      if (extra.type === 'attributes' && !hit.opts.attributes) continue
      if (extra.type === 'characterData' && !hit.opts.characterData) continue
      o.cb([{ target, type: 'childList', ...extra }])
    }
  }
  let frames = []
  const hub = createDomHub({ document: doc, MutationObserver: FakeObserver, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length }, cancelAnimationFrame: () => { frames = [] } })
  const flush = () => { const f = frames; frames = []; f.forEach((fn) => fn()) }
  return { hub, body, mutate, flush, pendingFrames: () => frames.length }
}

function sidebar(body) {
  const tree = new El({ role: 'tree' }).append(new El({ 'data-row-key': 'session:s1' }))
  const chat = new El({ 'data-chat-flow': '' })
  body.append(new El().append(tree), chat)
  return { tree, chat }
}

test('streaming inside the conversation schedules no sidebar work', () => {
  const { hub, body, mutate, flush, pendingFrames } = setup()
  const { chat } = sidebar(body)
  let sidebarRuns = 0
  hub.on('sidebar', () => sidebarRuns++)
  hub.start(); flush()
  assert.equal(sidebarRuns, 1, 'initial run once the tree is found')
  for (let i = 0; i < 200; i++) mutate(chat)
  mutate(chat, { type: 'characterData' })
  assert.equal(pendingFrames(), 0, 'no frame requested for chat-only mutations')
  flush()
  assert.equal(sidebarRuns, 1)
})

test('changes inside the session tree run sidebar subscribers once per frame', () => {
  const { hub, body, mutate, flush } = setup()
  const { tree } = sidebar(body)
  let runs = 0
  hub.on('sidebar', () => runs++)
  hub.start(); flush(); runs = 0
  const row = tree.children[0]
  mutate(row, { type: 'attributes' }); mutate(row, { type: 'characterData' }); mutate(tree)
  flush()
  assert.equal(runs, 1)
})

test('a remounted tree is re-observed', () => {
  const { hub, body, mutate, flush } = setup()
  const { tree } = sidebar(body)
  let runs = 0
  hub.on('sidebar', () => runs++)
  hub.start(); flush(); runs = 0
  const holder = tree.parent
  tree.remove()
  const fresh = new El({ role: 'tree' }).append(new El({ 'data-row-key': 'workspace:w1' }))
  holder.append(fresh)
  mutate(holder)
  flush()
  assert.equal(runs, 1)
  assert.deepEqual(hub.trees, [fresh])
  runs = 0
  mutate(fresh.children[0], { type: 'attributes' })
  flush()
  assert.equal(runs, 1, 'the new tree drives subscribers')
  mutate(tree)
  flush()
  assert.equal(runs, 1, 'the detached tree no longer does')
})

test('portals and dialogs notify their own subscribers', () => {
  const { hub, body, mutate, flush } = setup()
  sidebar(body)
  const seen = []
  hub.on('portal', () => seen.push('portal'))
  hub.on('dialog', () => seen.push('dialog'))
  hub.start(); flush(); seen.length = 0
  const menu = new El({ role: 'menu' })
  body.append(menu); mutate(body)
  flush()
  assert.deepEqual(seen, ['portal'])
  seen.length = 0
  const dialog = new El({ role: 'dialog' }).append(new El())
  body.append(dialog); mutate(body)
  flush()
  assert.deepEqual(seen, ['portal', 'dialog'])
  seen.length = 0
  mutate(dialog.children[0])
  flush()
  assert.deepEqual(seen, ['dialog'], 'changes inside an open dialog')
})

test('dispose stops everything and a throwing subscriber does not starve others', () => {
  const { hub, body, mutate, flush, pendingFrames } = setup()
  const { tree } = sidebar(body)
  let ok = 0
  hub.on('sidebar', () => { throw new Error('boom') })
  hub.on('sidebar', () => ok++)
  hub.start(); flush()
  assert.equal(ok, 1)
  hub.dispose()
  mutate(tree, { type: 'attributes' })
  assert.equal(pendingFrames(), 0)
})
