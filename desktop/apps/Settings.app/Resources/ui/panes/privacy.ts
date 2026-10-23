import { tiny } from '@tiny/sdk'
import { apps, attempt, button, cfgList, cfgSet, choose, group, h, line, say, sys, toggle, type Pane } from '../lib'

const CAP_NAMES: Record<string, string> = {
  'fs.user': 'Files', 'fs.picker': 'Picked files', 'fs.all': 'Full disk', clipboard: 'Clipboard', notifications: 'Notifications', 'audio.input': 'Microphone',
  'video.input': 'Camera', network: 'Network', location: 'Location', 'process.spawn': 'Run programs', 'display.capture': 'Screen recording',
}
interface Grant { appId: string; capability: string; status: 'granted' | 'denied' | 'prompt' }
interface Audit { time: number; event: string; appId: string | null; capability?: string; path?: string; call?: string; detail?: string }
const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)

async function matrix(): Promise<HTMLElement> {
  const list = (await apps()).filter((a) => a.kind === 'app')
  const grants = new Map<string, Grant[]>()
  for (const a of list) grants.set(a.id, (await k<Grant[]>('permList', a.id)).filter((g) => g.capability !== 'fs.container'))
  const caps = [...new Set([...grants.values()].flat().map((g) => g.capability))]
  const table = h('table', { class: 'matrix', 'aria-label': 'App permissions' },
    h('thead', null, h('tr', null, h('th', null, 'App'), caps.map((c) => h('th', null, CAP_NAMES[c] ?? c)), h('th', null, ''))),
    h('tbody', null, list.filter((a) => grants.get(a.id)!.length).map((a) => h('tr', { 'data-app': a.id },
      h('td', null, a.name),
      caps.map((c) => {
        const g = grants.get(a.id)!.find((x) => x.capability === c)
        if (!g) return h('td', null, '–')
        return h('td', null, toggle(`${a.name}: ${CAP_NAMES[c] ?? c}`, g.status === 'granted', async (on) => {
          await attempt(() => k(on ? 'permGrant' : 'permRevoke', a.id, c))
        }))
      }),
      h('td', null, button('Reset', async () => {
        for (const g of grants.get(a.id)!) await attempt(() => k('permReset', a.id, g.capability))
        const fresh = await matrix()
        table.replaceWith(fresh)
        say(`${a.name} will ask again.`)
      }, 'plain', { 'aria-label': `Reset permissions of ${a.name}` }))))))
  return table
}

async function searchPrivacy(): Promise<HTMLElement> {
  const box = h('div', { class: 'group' })
  const draw = async () => {
    const excluded = await sys<string[]>('tiny.search', { op: 'index.excluded' })
    const status = await sys<any>('tiny.search', { op: 'index.status' }).catch(() => null)
    box.replaceChildren(
      ...excluded.map((p) => line(p, button('Remove', async () => { await attempt(() => sys('tiny.search', { op: 'index.include', path: p })); void draw() }, 'plain', { 'aria-label': `Include ${p} in search` }))),
      ...(excluded.length ? [] : [line('No folders are excluded from search.')]),
      line(status ? `${status.indexed} items indexed${status.indexing ? ' (indexing…)' : ''}` : 'Search index',
        h('span', { class: 'row' },
          button('Exclude Folder…', async () => {
            const picked = await tiny.dialogs.openFolder({ title: 'Exclude from search' })
            if (picked?.[0]) { await attempt(() => sys('tiny.search', { op: 'index.exclude', path: picked[0] })); void draw() }
          }),
          button('Rebuild Index', () => attempt(() => sys('tiny.search', { op: 'index.rebuild' }), 'Rebuilding the search index.')))),
    )
  }
  await draw()
  return box
}

async function lock(): Promise<HTMLElement> {
  const s = await cfgList('tiny.session')
  const box = h('div', { class: 'group' })
  const draw = async () => {
    const has = await sys<boolean>('tiny.session', { op: 'hasPassword' })
    const change = async () => {
      const old = has ? await tiny.dialogs.prompt('Current password:', { title: 'Lock screen password' }) : ''
      if (old === null) return
      const pw = await tiny.dialogs.prompt(has ? 'New password (leave empty to remove):' : 'Choose a password:', { title: 'Lock screen password' })
      if (pw === null) return
      await attempt(() => sys('tiny.session', { op: 'setPassword', old, password: pw }), pw ? 'Password set.' : 'Password removed.')
      void draw()
    }
    box.replaceChildren(
      line('Lock screen password', h('span', { class: 'row' }, h('span', { class: 'dim' }, has ? 'Set' : 'None'), button(has ? 'Change…' : 'Set Password…', change))),
      line('Lock when waking from sleep', toggle('Lock on wake', s.lockOnWake, (v) => attempt(() => cfgSet('tiny.session', 'lockOnWake', v)))),
      line('When Pear quit unexpectedly', choose('Restore after a crash', [['ask', 'Ask me'], ['always', 'Reopen windows'], ['never', 'Do not reopen']], s.restoreOnCrash, (v) => attempt(() => cfgSet('tiny.session', 'restoreOnCrash', v)))))
  }
  await draw()
  return box
}

export const privacy: Pane = {
  id: 'privacy', title: 'Privacy & Security', icon: '✋', color: '#0a84ff', keywords: 'permissions camera microphone files location audit log search index exclude crash reports password lock restore',
  async render(root) {
    const sysCfg = await cfgList('tiny.system')
    const audit = (await k<Audit[]>('permAudit', 40)).slice().reverse()
    root.append(h('div', { class: 'pane' },
      h('section', null, h('h2', null, 'App permissions'), h('div', { class: 'group' }, h('div', { class: 'line col' }, await matrix()))),
      h('section', null, h('h2', null, 'Spotlight search privacy'), await searchPrivacy()),
      h('section', null, h('h2', null, 'Lock screen'), await lock()),
      group('Analytics', line('Share crash reports', toggle('Share crash reports', sysCfg.shareCrashReports === true, (v) => attempt(() => cfgSet('tiny.system', 'shareCrashReports', v))), 'Lets crash reports be sent to the developers.')),
      h('section', null, h('h2', null, 'Permission log'), h('div', { class: 'group' }, h('div', { class: 'line col' }, h('div', { class: 'log', 'aria-label': 'Permission log' },
        audit.length ? audit.map((e) => `${new Date(e.time).toLocaleTimeString()}  ${e.event}  ${e.appId ?? 'system'}  ${e.capability ?? e.path ?? e.call ?? ''}`).join('\n') : 'Nothing logged yet.'))))))
  },
}
