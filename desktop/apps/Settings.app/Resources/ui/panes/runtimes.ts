import { tiny } from '@tiny/sdk'
import { attempt, button, choose, group, h, line, say, type Pane } from '../lib'

/// Language runtimes: the programs that run Node.js, PHP and other languages. The kernel keeps
/// the registry; this is the view: what is installed, which version wins, which commands clash, and add or remove.

interface Runtime {
  name: string
  version: string
  bundleId: string
  bundleName: string
  abi: string[]
  commands: string[]
  shebangs: string[]
  handles: Array<{ ext: string[]; uti?: string }>
  default: boolean
  system: boolean
}
interface Framework { name: string; version: string; api: string | null; bundleId: string }
interface Conflict { command: string; holder: string; wanted: string }
interface Bundle { id: string; kind: string }

const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)
const APPSTORE = 'org.tiny.appstore'

const handled = (r: Runtime): string[] => [...new Set(r.handles.flatMap((x) => (x.ext.length ? x.ext.map((e) => `.${e}`) : x.uti ? [x.uti] : [])))]

function detail(r: Runtime): string {
  const parts = [`${r.bundleName} · version ${r.version}`, `abi ${r.abi.join(', ') || 'none'}`]
  parts.push(r.commands.length ? `commands: ${r.commands.join(', ')}` : 'no commands')
  const files = handled(r)
  if (files.length) parts.push(`opens ${files.join(', ')}`)
  if (r.system) parts.push('system')
  return parts.join(' · ')
}

function explain(): HTMLElement {
  return h('div', { class: 'group', id: 'runtimes-empty' },
    line('No runtime is installed.', null, 'A runtime is a program that lets Pear run programs written in another language, such as Node.js or PHP. Add a runtime to run Node.js, PHP… programs. Nothing is added until you choose to.'))
}

export const runtimesPane: Pane = {
  id: 'runtimes', title: 'Runtimes', icon: '⚙', color: '#5e5ce6', keywords: 'language node php python perl lua ruby interpreter command shebang framework add remove default version',
  async render(root) {
    const [list, frameworks, conflicts, bundles] = await Promise.all([
      k<Runtime[]>('runtimeList'),
      k<Framework[]>('frameworkList').catch(() => [] as Framework[]),
      k<Conflict[]>('runtimeConflicts').catch(() => [] as Conflict[]),
      k<Bundle[]>('bundleList').catch(() => [] as Bundle[]),
    ])
    const redraw = async (): Promise<void> => {
      const body = h('div')
      await runtimesPane.render(body)
      root.replaceChildren(...body.childNodes)
    }

    const remove = async (r: Runtime): Promise<void> => {
      if (r.system) return void say(`${r.bundleName} is part of the system and cannot be removed.`, true)
      if (!(await tiny.dialogs.confirm(`Remove ${r.bundleName} ${r.version}?`, { detail: 'Programs that need this runtime will stop running until you add one again.', danger: true, buttons: ['Remove', 'Cancel'] }))) return
      try {
        await k('bundleUninstall', r.bundleId)
      } catch (e) {
        const err = e as { code?: string; message?: string }
        say(err.code === 'EBUSY' ? `${r.bundleName} is in use. Quit the programs that use it, then try again.` : `${err.message ?? 'Could not remove it'}${err.code ? ` (${err.code})` : ''}`, true)
        return
      }
      await redraw()
      say(`${r.bundleName} was removed.`)
    }

    const addRuntime = async (): Promise<void> => {
      const picked = await tiny.dialogs.openFile({ title: 'Add Runtime', button: 'Add', filters: [{ name: 'Pear packages', ext: ['pearapp'] }] })
      if (!picked?.length) return
      // the install review is the Installer's: it shows the commands, file types, conflicts and the trust warning
      await attempt(() => tiny.shell.open(picked[0]!), 'Review the runtime in the installer, then choose Install. This list updates when you come back.')
    }

    const names = [...new Set(list.map((r) => r.name))].sort()
    const rows: HTMLElement[] = []
    for (const name of names) {
      const versions = list.filter((r) => r.name === name).sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))
      for (const r of versions) {
        rows.push(h('div', { class: 'line', 'data-runtime': r.bundleId },
          h('div', { class: 'label' }, h('span', null, `${r.name} ${r.version}`, r.default ? h('span', { class: 'badge-default', style: 'margin-left:8px;font-size:11px;color:var(--accent)' }, 'Default') : null), h('small', null, detail(r))),
          h('div', { class: 'ctl' }, button('Remove', () => remove(r), 'danger', { disabled: r.system, 'aria-label': `Remove ${r.bundleName} ${r.version}` }))))
      }
      if (versions.length > 1) {
        const def = versions.find((r) => r.default) ?? versions[0]!
        rows.push(line(`Default ${name}`, choose(`Default version of ${name}`, versions.map((r) => [r.bundleId, `${r.version} (${r.bundleName})`] as [string, string]), def.bundleId, async (id) => {
          if ((await attempt(() => k('runtimeSetDefault', name, id), `${name} now uses ${versions.find((r) => r.bundleId === id)?.version ?? 'that version'} by default.`)) !== undefined) await redraw()
        }), 'Used when a program asks for this language without a version.'))
      }
    }

    const store = bundles.some((b) => b.id === APPSTORE)
    const actions = h('div', { class: 'row', style: 'display:flex;gap:8px;flex-wrap:wrap' },
      button('Add Runtime…', addRuntime, 'primary', { 'aria-label': 'Add Runtime from a file' }),
      store ? button('Get runtimes from the App Store', () => attempt(() => tiny.shell.openApp(APPSTORE)), '', { 'aria-label': 'Get runtimes from the App Store' }) : null)

    root.append(h('div', { class: 'pane' },
      h('section', null, h('h2', null, 'Installed runtimes'), list.length ? h('div', { class: 'group', id: 'runtimes' }, rows) : explain()),
      actions,
      conflicts.length ? group('Command conflicts', conflicts.map((c) => line(c.command, h('span', { class: 'val' }, `kept by ${c.holder}`),
        `${c.wanted} also provides “${c.command}”${c.holder === 'system' ? ', but a system program has that name' : ''}. The first runtime added keeps the command.`))) : null,
      frameworks.length ? group('Frameworks', frameworks.map((f) => line(f.name, h('span', { class: 'val' }, `version ${f.version}`), `${f.bundleId}${f.api ? ` · api ${f.api}` : ''}`))) : null,
      h('p', { class: 'status' }, 'A runtime runs inside every app that uses it, with that app’s rights. Only add runtimes you trust.')))
  },
}
