// A soft-deleted blank can still be selected in another tab, or reused by
// native New Session navigation. A new real user message is an explicit use
// of that conversation; background output is not a request to restore it.
export function watchTrashedSessionReuse(ctx, restore) {
  if (typeof ctx.on !== 'function') return () => {}
  let disposed = false
  const pending = new Set()
  const off = ctx.on('session/event', (session, event) => {
    if (disposed || event?.type !== 'user/message' || event.data?.source?.kind !== 'user'
      || !Number.isFinite(event.time) || event.time <= 0 || !session?.id) return
    const task = Promise.resolve().then(() => {
      if (!disposed) return restore(String(session.id), event.time)
    }).catch((error) => {
      ctx.logger?.warn?.(`[dsh-sessions-manager] restore reused conversation failed: ${String(error)}`)
    })
    pending.add(task)
    void task.finally(() => pending.delete(task))
    return task
  })
  return async () => {
    disposed = true
    if (typeof off === 'function') off()
    await Promise.allSettled([...pending])
  }
}
