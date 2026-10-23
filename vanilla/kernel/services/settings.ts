import { Subscribers, needPort, serve } from './lib'
import type { Pear } from '../src/runtime'

interface Subscriber {
  port: number
  domain: string
  key?: string
}

/**
 * `tiny.settings`: read and write settings for a caller (with the caller's rights: an app can write only its own
 * domain), and tell subscribers when something changes. A subscriber sends `{op: 'watch', domain, key?}` with one
 * of its ports in `rights`, and gets `{type: 'changed', change}` on it.
 */
export default async (tiny: Pear) => {
  const subscribers = new Subscribers<Subscriber>(tiny, 256)
  return serve(
    tiny,
    'tiny.settings',
    {
      get: (a) => tiny.configGet(a.domain, a.key, a.default),
      list: (a) => tiny.configList(a.domain),
      set: async (a, m) => void (await tiny.configSet(a.domain, a.key, a.value, { as: m.from, scope: a.scope })),
      delete: async (a, m) => void (await tiny.configDelete(a.domain, a.key, { as: m.from, scope: a.scope })),
      reset: async (a, m) => void (await tiny.configReset(a.domain, { as: m.from, scope: a.scope })),
      watch: (a, m) => {
        subscribers.add({ port: needPort(m), domain: String(a.domain), key: typeof a.key === 'string' ? a.key : undefined })
      },
      unwatch: (_a, m) => subscribers.removePort(m.rights[0] as number),
    },
    async (data) => {
      if (data?.type !== 'config-changed') return
      for (const s of [...subscribers.items]) {
        if (s.domain !== data.domain || (s.key !== undefined && s.key !== data.key)) continue
        await tiny.send(s.port, { type: 'changed', change: data }).catch(() => subscribers.items.delete(s))
      }
    },
    async (port) => void (await tiny.configWatch('*', null, port)),
  )
}
