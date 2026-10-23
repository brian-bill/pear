import { fail, needPort, serve } from './lib'
import type { Pear } from '../src/runtime'

interface Notification {
  id: number
  /** Who posted it: the app's bundle id, or `null` for programs outside any app. */
  appId: string | null
  title: string
  body: string
  time: number
}

const MAX_PER_APP = 50
const MAX_TOTAL = 500

/**
 * `tiny.notifications`: keeps the notifications that were posted and tells subscribers (Desktop's notification
 * center) about new and dismissed ones. Posting needs the `notifications` permission.
 */
export default async (tiny: Pear) => {
  const items: Notification[] = []
  const subscribers = new Set<number>()
  let nextId = 1
  const tell = async (event: unknown) => {
    for (const port of [...subscribers]) await tiny.send(port, event).catch(() => subscribers.delete(port))
  }
  const dismiss = async (id: number) => {
    const at = items.findIndex((n) => n.id === id)
    if (at < 0) return false
    items.splice(at, 1)
    await tell({ type: 'dismissed', id })
    return true
  }

  return serve(tiny, 'tiny.notifications', {
    post: async (a, m) => {
      if (typeof a.title !== 'string' || !a.title || a.title.length > 200) throw fail('EINVAL', 'title must be 1-200 characters')
      if (a.body !== undefined && (typeof a.body !== 'string' || a.body.length > 2000)) throw fail('EINVAL', 'body must be text up to 2000 characters')
      let status = await tiny.permCheck('notifications', undefined, { as: m.from })
      if (status === 'prompt') status = await tiny.permRequest('notifications', { as: m.from })
      if (status !== 'granted') throw fail('EPERM', 'this app may not post notifications')
      const appId = (await tiny.info(m.from)).appId
      if (items.filter((n) => n.appId === appId).length >= MAX_PER_APP) await dismiss(items.find((n) => n.appId === appId)!.id)
      if (items.length >= MAX_TOTAL) await dismiss(items[0]!.id)
      const n: Notification = { id: nextId++, appId, title: a.title, body: a.body ?? '', time: Date.now() }
      items.push(n)
      await tell({ type: 'posted', notification: n })
      return n.id
    },
    list: (a) => items.filter((n) => a.app === undefined || n.appId === a.app),
    dismiss: async (a, m) => {
      const n = items.find((x) => x.id === a.id)
      const caller = await tiny.info(m.from)
      if (n && caller.appId && n.appId !== caller.appId) throw fail('EPERM', 'not your notification')
      return dismiss(a.id)
    },
    clear: async (a, m) => {
      const caller = await tiny.info(m.from)
      const app = caller.appId ?? a.app
      for (const n of items.filter((x) => app === undefined || x.appId === app)) await dismiss(n.id)
    },
    subscribe: (_a, m) => {
      subscribers.add(needPort(m))
    },
    unsubscribe: (_a, m) => void subscribers.delete(m.rights[0] as number),
  })
}
