// Follow the public catalog and lifecycle notifications, not transcript DOM
// mutations. Normal token streaming must not produce whole-list requests.
export function shouldHideEmptySession(info, summary, selected = false) {
  return !!info?.empty && !selected && summary?.blank !== false && !summary?.running
}

export function installSessionSync({ sessions, remote, refreshSidebar, document: doc,
  setTimeout: later = setTimeout, clearTimeout: cancel = clearTimeout, delay = 120,
  onError = () => {} }) {
  if (typeof sessions?.list?.subscribe !== 'function') return () => {}
  let disposed = false
  let timer = null
  let running = false
  let dirty = false
  let reload = false
  let previous = ''
  const disposers = []

  const request = (full = false) => {
    if (disposed) return
    dirty = true
    reload ||= full
    if (timer !== null || running || doc?.hidden) return
    timer = later(run, delay)
  }
  const run = async () => {
    timer = null
    if (disposed || doc?.hidden) return
    running = true
    dirty = false
    const full = reload
    reload = false
    try {
      if (full && typeof sessions.refresh === 'function') await sessions.refresh()
      if (!disposed) await refreshSidebar()
    } catch (error) {
      onError(error)
    } finally {
      running = false
      if (dirty && !disposed) request()
    }
  }
  const changed = () => {
    const snapshot = sessions.list.getSnapshot()
    if (!Array.isArray(snapshot?.ids) || !snapshot.byId) return
    const signature = JSON.stringify(snapshot.ids.map((id) => {
      const row = snapshot.byId[id]
      return [id, row?.blank, row?.running, row?.updatedAt, row?.title, row?.cwd]
    }))
    if (signature === previous) return
    previous = signature
    request()
  }
  disposers.push(sessions.list.subscribe(changed))
  changed()

  if (typeof remote?.$on === 'function') {
    for (const event of ['api-session/added', 'api-session/status', 'api-session/activity', 'api-session/removed']) {
      try {
        disposers.push(remote.$on(event, (value) => {
          const id = typeof value === 'string' ? value : value?.sessionId
          const row = sessions.list.getSnapshot()?.byId?.[id]
          // A disposal withdraws the live instance, not its persisted log. Repair
          // the catalog baseline so a background conversation cannot disappear.
          request(event === 'api-session/removed' || !row || row.blank === true)
        }))
      } catch (error) { onError(error) } // older runtimes may not declare every event
    }
  }
  if (typeof doc?.addEventListener === 'function') {
    const visible = () => { if (!doc.hidden) request(true) }
    doc.addEventListener('visibilitychange', visible)
    disposers.push(() => doc.removeEventListener('visibilitychange', visible))
  }
  return () => {
    disposed = true
    if (timer !== null) cancel(timer)
    for (const stop of disposers) if (typeof stop === 'function') stop()
  }
}
