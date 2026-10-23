import { tiny } from '@tiny/sdk'
import { group, h, info, line, sys, type Pane } from '../lib'

interface Assertion { id: number; type: string; reason: string; owner: number; since: number }

export const power: Pane = {
  id: 'power', title: 'Battery', icon: '🔋', color: '#30d158', keywords: 'power energy charging sleep assertions wake lock',
  async render(root) {
    const [battery, list, state] = await Promise.all([
      tiny.system.info('battery').catch(() => null),
      sys<Assertion[]>('tiny.timers', { op: 'power.assertions' }).catch(() => [] as Assertion[]),
      sys<any>('tiny.timers', { op: 'power.state' }).catch(() => null),
    ])
    root.append(h('div', { class: 'pane' },
      group('Battery', battery
        ? [info('Charge', `${Math.round(battery.level * 100)}%`), info('Status', battery.charging ? 'Charging' : 'On battery')]
        : line('No battery', undefined, 'This computer does not report a battery, or the browser hides it.')),
      group('Preventing sleep',
        state ? info('Sleep prevented', state.preventsSleep ? 'Yes' : 'No') : null,
        list.length ? list.map((a) => line(`${a.type}: ${a.reason}`, h('span', { class: 'val' }, `process ${a.owner}`), `Since ${new Date(a.since).toLocaleTimeString()}`)) : line('Nothing is keeping Pear awake.'))))
  },
}
