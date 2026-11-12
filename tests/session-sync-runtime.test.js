// Run the shipped browser bundle with Cordis and the actual 0.2.2-rc.1
// catalog service. No live profile, model request, or message log is involved.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import * as jsx from 'react/jsx-runtime'

const require = createRequire(import.meta.url)
const pkg = dirname(require.resolve('@deepseek-ai/dsh-api-session-controller/package.json'))
const { ClientSessions } = await import(pathToFileURL(join(pkg, 'lib/types/client/sessions/service.js')))
const waitFor = async check => {
  const deadline = Date.now() + 2000
  while (!check()) {
    assert.ok(Date.now() < deadline, 'expected the event-driven update within two seconds')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

test('browser bundle attaches through real Cordis and repairs a disposed native catalog entry', async t => {
  const ctx = new Context()
  const listeners = new Map()
  const requests = []
  let listReads = 0
  const summary = { sessionId: 'background-image', blank: false, running: false, agentAvailable: false, updatedAt: 2, cwd: '/test' }
  const remote = {
    session: { list: async () => { listReads++; return { ok: true, value: { items: [summary] } } } },
    $on(name, fn) {
      if (!listeners.has(name)) listeners.set(name, new Set())
      listeners.get(name).add(fn)
      return () => listeners.get(name).delete(fn)
    },
  }
  ctx.provide('remote'); ctx.set('remote', remote)
  ctx.provide('slots'); ctx.set('slots', { inject: () => {}, register: () => () => {} })
  t.mock.method(globalThis, 'fetch', async path => {
    requests.push(path)
    return { ok: true, json: async () => ({}) }
  })
  const sessions = new ClientSessions(ctx, remote)
  sessions.handleSessionAdded({ ...summary, blank: true, updatedAt: 1 })

  let client
  const window = { __ModuleLoader__: { load({ factory }) {
    client = factory(name => {
      if (name === 'react') return React
      if (name === 'react/jsx-runtime') return jsx
      throw new Error(`unexpected browser import ${name}`)
    })
  } } }
  new Function('window', readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8'))(window)
  const fork = ctx.plugin(client)
  t.after(async () => { await ctx.fiber.dispose() })
  await fork
  await waitFor(() => requests.includes('/archived-sessions/sidebar-state'))
  requests.length = 0

  // Host acceptance is enough; no assistant reply or completion is needed.
  sessions.handleSessionStatus(summary.sessionId, true)
  sessions.handleSessionActivity(summary.sessionId, 2)
  for (const fn of listeners.get('api-session/activity') || []) fn(summary.sessionId, 2)
  await waitFor(() => sessions.list.getSnapshot().byId[summary.sessionId]?.blank === false)
  await waitFor(() => requests.includes('/archived-sessions/sidebar-state'))

  sessions.handleSessionRemoved(summary.sessionId)
  await waitFor(() => sessions.list.getSnapshot().byId[summary.sessionId] === undefined)
  for (const fn of listeners.get('api-session/removed') || []) fn(summary.sessionId)
  await waitFor(() => listReads > 0 && sessions.list.getSnapshot().byId[summary.sessionId] !== undefined)
  assert.equal(sessions.list.getSnapshot().byId[summary.sessionId].blank, false)

  await fork.dispose()
  assert.ok([...listeners.values()].every(set => set.size === 0), 'HMR/unload removes every Remote subscription')
})
