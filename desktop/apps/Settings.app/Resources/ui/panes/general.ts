import { formatBytes, tiny } from '@tiny/sdk'
import { apps, attempt, button, choose, group, h, info, line, nameOf, say, sys, type Pane } from '../lib'
import { backupSection } from './backup'

const S = 'tiny.session'
const uptime = (ms: number) => {
  const m = Math.floor(ms / 60000)
  return m < 1 ? 'less than a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

async function updateSection(): Promise<HTMLElement> {
  const box = h('div', { class: 'group' })
  const draw = async () => {
    const u = await sys<{ ready: boolean; version?: string }>(S, { op: 'update.status' })
    box.replaceChildren(line(u.ready ? `Version ${u.version ?? 'new'} is ready to install` : 'Pear is up to date',
      h('span', { class: 'row' },
        button('Check Now', async () => { await attempt(() => sys(S, { op: 'update.check' }), 'Checked for updates.'); setTimeout(() => void draw(), 1500) }),
        u.ready ? button('Restart to Update', () => attempt(() => sys(S, { op: 'update.apply' })), 'primary') : null)))
  }
  await draw()
  return box
}

async function startupSection(): Promise<HTMLElement> {
  const all = await apps()
  const box = h('div', { class: 'group' })
  const draw = async () => {
    const items = await sys<string[]>(S, { op: 'startup.list' })
    const change = async (op: string, appId: string) => { await attempt(() => sys(S, { op, appId })); void draw() }
    box.replaceChildren(
      ...items.map((id) => line(nameOf(all, id), button('Remove', () => change('startup.remove', id), 'plain', { 'aria-label': `Remove ${nameOf(all, id)} from startup items` }))),
      ...(items.length ? [] : [line('No apps open at login.')]),
      line('', choose('Add startup item', [['', 'Add app…'] as [string, string], ...all.filter((a) => !items.includes(a.id)).map((a) => [a.id, a.name] as [string, string])], '', (id) => { if (id) void change('startup.add', id) })))
  }
  await draw()
  return box
}

export const general: Pane = {
  id: 'general', title: 'General', icon: '⚙', color: '#8e8e93', keywords: 'about system information computer name hostname storage update startup login items backup restore version memory',
  async render(root) {
    const s = await tiny.system.info('snapshot')
    const name = h('input', { type: 'text', 'aria-label': 'Computer name', value: s.hostname, style: 'width:200px' })
    name.value = s.hostname
    const commit = async () => {
      const v = name.value.trim()
      if (v === s.hostname) return
      if ((await attempt(() => sys('tiny.system', { op: 'setHostname', name: v }), 'Computer name changed.')) !== undefined) s.hostname = v
      else name.value = s.hostname
    }
    name.addEventListener('change', () => void commit())
    const { usage, quota, persisted } = s.storage
    const persist = button(persisted ? 'Kept' : 'Keep Storage', async () => {
      const ok = await attempt(() => sys<boolean>('tiny.system', { op: 'persist' }))
      say(ok ? 'Your browser will keep Pear’s files.' : 'Your browser declined to keep the storage.', !ok)
      if (ok) { persist.textContent = 'Kept'; persist.disabled = true }
    }, '', { disabled: persisted === true })

    root.append(h('div', { class: 'pane' },
      group('About',
        line('Name', name, 'How this computer is named on the network.'),
        info('Pear', `${s.version.version} (${s.version.build})`),
        info('Kernel', s.version.kernel),
        info('Processor', `${s.hardware.cores ?? '—'} cores`),
        info('Memory', s.hardware.memoryHint ? `${s.hardware.memoryHint} GB` : '—'),
        info('Language', s.locale.tag),
        info('Uptime', uptime(s.uptime))),
      group('Storage',
        line(usage === null ? 'Storage use is unknown' : `${formatBytes(usage)} of ${formatBytes(quota ?? 0)} used`, h('span', { class: 'row' }, quota ? h('span', { class: 'bar', style: 'width:140px' }, h('i', { style: `width:${Math.min(100, (usage / quota) * 100)}%` })) : null, persist), persisted ? 'Kept: the browser will not clear it.' : 'The browser may clear it when space is low.')),
      h('section', null, h('h2', null, 'Software update'), await updateSection()),
      h('section', null, h('h2', null, 'Login items'), await startupSection()),
      backupSection()))
  },
}
