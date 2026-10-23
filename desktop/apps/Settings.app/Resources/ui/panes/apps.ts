import { tiny } from '@tiny/sdk'
import { attempt, button, choose, group, h, line, say, type Pane } from '../lib'

interface Bundle { id: string; name: string; version: string; kind: string; system: boolean; permissions: string[]; path: string }
interface Rec { id: string; name: string }
interface Conflict { ext: string | null; uti: string; claims: Array<{ uti: string; appId: string | null }>; kept: string | null }
const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)

const TYPES: Array<[string, string]> = [
  ['public.plain-text', 'Text files'], ['public.json', 'JSON files'], ['public.html', 'Web pages'], ['public.image', 'Images'], ['public.pdf', 'PDF documents'],
  ['public.audio', 'Audio'], ['public.movie', 'Video'], ['public.archive', 'Archives'], ['public.source-code', 'Source code'], ['public.folder', 'Folders'],
]

async function defaults(): Promise<HTMLElement> {
  const rows: HTMLElement[] = []
  for (const [uti, label] of TYPES) {
    const [cands, cur] = await Promise.all([tiny.launchAppsFor(uti).catch(() => [] as Rec[]), k<Rec | null>('launchDefaultFor', uti).catch(() => null)])
    if (!cands.length) continue
    rows.push(line(label, choose(`Default app for ${label}`, cands.map((a) => [a.id, a.name] as [string, string]), cur?.id ?? cands[0]!.id, (id) => attempt(() => k('launchSetDefault', uti, id)))))
  }
  return h('div', { class: 'group' }, rows.length ? rows : line('No app has registered file types yet.'))
}

async function conflicts(): Promise<HTMLElement | null> {
  const list = await k<Conflict[]>('launchTypeConflicts').catch(() => [])
  if (!list.length) return null
  return group('File type conflicts', list.map((c) => line(c.ext ? `.${c.ext}` : c.uti,
    choose(`Type for ${c.ext ?? c.uti}`, c.claims.map((cl) => [cl.uti, `${cl.uti}${cl.appId ? ` (${cl.appId})` : ''}`] as [string, string]), c.kept ?? c.claims[0]!.uti,
      (uti) => (c.ext ? attempt(() => k('launchSetTypeOwner', c.ext, uti), 'Saved.') : undefined)), 'Several apps define this type.')))
}

export const appsPane: Pane = {
  id: 'apps', title: 'Apps', icon: '▦', color: '#ff9f0a', keywords: 'installed applications uninstall default open with file types permissions version',
  async render(root) {
    const bundles = (await k<Bundle[]>('bundleList')).filter((b) => b.kind === 'app').sort((a, b) => a.name.localeCompare(b.name))
    const list = h('div', { class: 'group' })
    const draw = (items: Bundle[]) => list.replaceChildren(...items.map((b) => h('div', { class: 'line', 'data-app': b.id },
      h('div', { class: 'label' }, b.name, h('small', null, `${b.id} · version ${b.version}${b.system ? ' · system' : ''}${b.permissions.length ? ` · ${b.permissions.join(', ')}` : ''}`)),
      h('div', { class: 'ctl' }, button('Uninstall', async () => {
        if (b.system) return void say(`${b.name} is part of the system and cannot be removed.`, true)
        if (!(await tiny.dialogs.confirm(`Uninstall ${b.name}?`, { detail: 'The app is removed. Its data is kept.', danger: true, buttons: ['Uninstall', 'Cancel'] }))) return
        if ((await attempt(() => k('bundleUninstall', b.id), `${b.name} was uninstalled.`)) === undefined) return
        draw((await k<Bundle[]>('bundleList')).filter((x) => x.kind === 'app').sort((x, y) => x.name.localeCompare(y.name)))
      }, 'danger', { disabled: b.system, 'aria-label': `Uninstall ${b.name}` })))))
    draw(bundles)
    const conf = await conflicts()
    root.append(h('div', { class: 'pane' },
      h('section', null, h('h2', null, 'Installed apps'), list),
      h('section', null, h('h2', null, 'Default apps'), await defaults()),
      conf))
  },
}
