import { apps, attempt, cfgList, cfgSet, group, line, toggle, h, type Pane } from '../lib'

const D = 'tiny.notifications'

export const notifications: Pane = {
  id: 'notifications', title: 'Notifications', icon: '🔔', color: '#ff453a', keywords: 'do not disturb dnd focus alerts banners apps allow',
  async render(root) {
    const [n, all] = await Promise.all([cfgList(D), apps()])
    const allowed: Record<string, boolean> = { ...(n.apps ?? {}) }
    root.append(h('div', { class: 'pane' },
      group(null, line('Do Not Disturb', toggle('Do Not Disturb', n.dnd === true, (v) => attempt(() => cfgSet(D, 'dnd', v))), 'Silences banners; they still arrive in Notification Center.')),
      group('Allow notifications from',
        all.map((a) => line(a.name, toggle(`Allow notifications from ${a.name}`, allowed[a.id] !== false, (v) => {
          allowed[a.id] = v
          return attempt(() => cfgSet(D, 'apps', { ...allowed }))
        }))))))
  },
}
