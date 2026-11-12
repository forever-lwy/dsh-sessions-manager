import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { watchTrashedSessionReuse } from '../src/trash-resume.js'

let root, routes, emit, state
const disposers = []
const broadcasts = []
const id = 'pending-image-session'

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsm-trash-resume-'))
  process.env.DSH_SESSIONS_MANAGER_TRASH_DIR = join(root, 'trash')
  process.env.DSH_SESSIONS_MANAGER_STAR_DIR = join(root, 'state')
  process.env.DSH_SESSIONS_MANAGER_PENDING_DIR = join(root, 'pending')
  await mkdir(join(root, id), { recursive: true })
  const file = join(root, id, 'session.jsonl.zstd')
  await writeFile(file, 'original conversation log')
  const header = { id, cwd: root, createdAt: 1 }
  const session = { id, header, events: [] }
  state = { archivedSessionIds: [] }
  routes = new Map()
  const listeners = new Map()
  const ctx = {
    workspaceRegistry: { list: () => [], state, archiveSession: async () => {} },
    sessionPersistence: { list: async () => [header], locate: () => ({ path: file }), readFrom: async () => ({ meta: header, events: [] }) },
    sessionQuery: {},
    storageDomain: { get: () => ({ global: { get: () => state, set: async next => Object.assign(state, next) } }) },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => {} } },
    get: name => name === 'sessions' ? { get: () => session, list: () => [session] } : null,
    effect: fn => { const stop = fn(); if (typeof stop === 'function') disposers.push(stop) },
    on: (name, fn) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(fn); return () => listeners.get(name).delete(fn) },
    emit: (name, ...args) => { broadcasts.push({ name, args }) },
    logger: { warn: message => { throw new Error(message) } },
  }
  emit = async event => { await Promise.all([...(listeners.get('session/event') || [])].map(fn => fn(session, event))) }
  const { apply } = await import(`../src/index.js?trashResume=${Date.now()}`)
  apply(ctx)
})
after(async () => {
  await Promise.all(disposers.map(stop => stop()))
  await rm(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 })
})

async function call(path, body = {}) {
  let status = 200, output = ''
  await routes.get(path)(Readable.from([Buffer.from(JSON.stringify(body))]), {
    writeHead: value => { status = value }, end: value => { output += value || '' },
  })
  return { status, body: JSON.parse(output) }
}
const trash = async () => JSON.parse(await readFile(join(root, 'trash', 'index.json'), 'utf8'))
const userMessage = time => ({ type: 'user/message', time, data: { source: { kind: 'user' } } })

test('a deleted blank reused for a new user message is durably restored before its refresh notification', async () => {
  await call('/archived-sessions/delete', { sessionId: id })
  const deletedAt = (await trash()).items.find(item => item.sessionId === id).deletedAt
  broadcasts.length = 0
  await emit(userMessage(deletedAt + 1))
  assert.equal((await trash()).items.some(item => item.sessionId === id), false)
  assert.deepEqual(state.archivedSessionIds, [])
  assert.equal(await readFile(join(root, id, 'session.jsonl.zstd'), 'utf8'), 'original conversation log')
  assert.deepEqual(broadcasts, [{ name: 'api-session/activity', args: [id, deletedAt + 1] }])
  await emit(userMessage(deletedAt + 2))
  assert.equal(broadcasts.length, 1, 'normal sends do not create restore notifications')
})

test('background replies, title generation, plugin context, and pre-delete messages leave intentional deletions in trash', async () => {
  await call('/archived-sessions/delete', { sessionId: id })
  const deletedAt = (await trash()).items.find(item => item.sessionId === id).deletedAt
  broadcasts.length = 0
  await emit({ type: 'assistant/message', time: deletedAt + 1 })
  await emit({ type: 'session/title', time: deletedAt + 1 })
  await emit({ type: 'user/message', time: deletedAt + 1, data: { source: { kind: 'plugin:context' } } })
  await emit(userMessage(deletedAt - 1))
  await emit(userMessage(deletedAt))
  await emit(userMessage(Number.NaN))
  assert.equal((await trash()).items.some(item => item.sessionId === id), true)
  assert.equal(broadcasts.length, 0)
})

test('a fresh delete wins over an older user activity even when restores are queued', async () => {
  await call('/archived-sessions/delete', { sessionId: id })
  const deletedAt = (await trash()).items.find(item => item.sessionId === id).deletedAt
  const message = emit(userMessage(deletedAt - 1))
  const deletion = call('/archived-sessions/delete', { sessionId: id })
  await Promise.all([message, deletion])
  assert.equal((await trash()).items.some(item => item.sessionId === id), true)
})

test('unloading stops new restore work and waits for an admitted restoration', async () => {
  let listener, release, finished = false, calls = 0
  const stop = watchTrashedSessionReuse({ on: (_, fn) => { listener = fn; return () => {} } }, async () => {
    calls++
    await new Promise(resolve => { release = resolve })
  })
  const running = listener({ id }, userMessage(1))
  await Promise.resolve()
  const stopping = stop().then(() => { finished = true })
  assert.equal(finished, false)
  assert.equal(listener({ id }, userMessage(2)), undefined)
  release()
  await Promise.all([running, stopping])
  assert.equal(calls, 1)
  assert.equal(finished, true)
})
