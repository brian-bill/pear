import { tiny } from '@tiny/sdk'
import { attempt, button, group, h, line, toggle, type Pane } from '../lib'

/// Commands and services: the programs bundles add to the shell, development links, and background services.
/// The kernel keeps the registries; this is the view and the few controls (take over, remove a link, start and stop, autostart, logs).

interface Command {
  name: string
  summary: string | null
  bundleId: string
  bundleName: string
  owner: { kind: 'bundle'; id: string } | { kind: 'link'; path: string } | { kind: 'runtime'; name: string }
  shim: string
}
interface Conflict { name: string; holder: string; wanted: string }
interface Link { path: string; bundleId: string; name: string; commands: string[]; broken: boolean; reason?: string }
interface Service {
  id: string
  name: string
  bundleName: string
  state: 'stopped' | 'starting' | 'running' | 'failed'
  pid: number | null
  restarts: number
  lastExit: { code: number | null; signal: string | null; at: number } | null
  enabled: boolean
  reason: string | null
  project: string | null
  system: boolean
}
interface LogLine { time: number; stream: 'stdout' | 'stderr'; message: string }

const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)

const ownerText = (c: Command): string => (c.owner.kind === 'link' ? `linked from ${c.owner.path}` : c.owner.kind === 'runtime' ? `runtime ${c.owner.name}` : c.bundleName)
const exitText = (e: Service['lastExit']): string => (e ? `${e.signal ? `signal ${e.signal}` : `code ${e.code ?? '?'}`} at ${new Date(e.at).toLocaleTimeString()}` : 'none')

export const commandsPane: Pane = {
  id: 'commands', title: 'Commands and Services', icon: '⌘', color: '#34c759', keywords: 'command shell terminal path link service daemon background autostart restart logs take over conflict',
  async render(root) {
    root.append(...(await build()))
    // the lists follow the system while the pane is open
    let timer: ReturnType<typeof setTimeout> | undefined
    const later = (): void => {
      clearTimeout(timer)
      timer = setTimeout(async () => {
        if (!root.isConnected) return stop()
        if (document.activeElement?.matches('input, select, textarea') || root.querySelector('.log')) return
        root.replaceChildren(...(await build()))
      }, 300)
    }
    const stop = (): void => {
      clearTimeout(timer)
      offs.forEach((f) => f())
    }
    const offs = [tiny.on('command', later), tiny.on('service', later)]
  },
}

async function build(): Promise<Node[]> {
  {
    const [commands, conflicts, links, services] = await Promise.all([
      k<Command[]>('commandList').catch(() => [] as Command[]),
      k<Conflict[]>('commandConflicts').catch(() => [] as Conflict[]),
      k<Link[]>('commandLinks').catch(() => [] as Link[]),
      k<Service[]>('serviceList').catch(() => [] as Service[]),
    ])
    const body = h('div')
    const redraw = async (): Promise<void> => {
      body.replaceChildren(...(await build()))
    }
    const act = async (fn: () => Promise<unknown>, ok: string): Promise<void> => {
      await attempt(fn, ok)
      await redraw()
    }

    const logs = new Map<string, HTMLElement>()
    const showLogs = async (s: Service): Promise<void> => {
      const open = logs.get(s.id)
      if (open) {
        open.remove()
        logs.delete(s.id)
        return
      }
      const lines = (await attempt(() => k<LogLine[]>('serviceLogs', s.id, { limit: 200 }))) ?? []
      const box = h('pre', { class: 'log', 'aria-label': `Logs of ${s.bundleName}` }, lines.length ? lines.map((l) => `${new Date(l.time).toLocaleTimeString()} ${l.stream === 'stderr' ? '!' : ' '} ${l.message}`).join('\n') : 'No output yet.')
      logs.set(s.id, box)
      listEl.querySelector(`[data-service="${CSS.escape(s.id)}"]`)?.after(box)
    }

    const serviceRow = (s: Service): HTMLElement => {
      const running = s.state === 'running' || s.state === 'starting'
      const detail = [`${s.state}${s.pid !== null ? ` · pid ${s.pid}` : ''}`, `${s.restarts} restart${s.restarts === 1 ? '' : 's'}`, `last exit: ${exitText(s.lastExit)}`, s.reason, s.project ? `project ${s.project}` : null].filter(Boolean).join(' · ')
      return h('div', { class: 'line', 'data-service': s.id },
        h('div', { class: 'label' }, `${s.bundleName} (${s.name})`, h('small', null, detail)),
        h('div', { class: 'ctl' },
          toggle(`Start ${s.bundleName} at boot`, s.enabled, (on) => act(() => k(on ? 'serviceEnable' : 'serviceDisable', s.id), `${s.bundleName} ${on ? 'will start at boot' : 'will not start at boot'}.`)),
          h('span', { class: 'dim' }, 'Autostart'),
          running ? button('Stop', () => act(() => k('serviceStop', s.id), `${s.bundleName} was stopped.`), '', { 'aria-label': `Stop ${s.bundleName}` }) : button('Start', () => act(() => k('serviceStart', s.id), `${s.bundleName} was started.`), '', { 'aria-label': `Start ${s.bundleName}` }),
          button('Restart', () => act(() => k('serviceRestart', s.id), `${s.bundleName} was restarted.`), '', { 'aria-label': `Restart ${s.bundleName}` }),
          button('Logs', () => showLogs(s), '', { 'aria-label': `Logs of ${s.bundleName}` })))
    }
    const listEl = h('div', { class: 'group', id: 'services' }, services.map(serviceRow))

    body.append(h('div', { class: 'pane' },
      commands.length
        ? group('Commands', commands.map((c) => h('div', { class: 'line', 'data-command': c.name },
          h('div', { class: 'label' }, c.name, h('small', null, [c.summary, `from ${ownerText(c)}`, `shim ${c.shim}`].filter(Boolean).join(' · '))))))
        : group('Commands', line('No commands are registered.', null, 'Apps and tools can add commands you run in the Terminal.')),
      conflicts.length ? group('Conflicts', conflicts.map((c) => line(c.name, button('Take Over', () => act(() => k('commandTakeOver', c.name, c.wanted), `${c.wanted} now has “${c.name}”.`), '', { 'aria-label': `Let ${c.wanted} take over ${c.name}` }),
        `${c.wanted} also wants “${c.name}”, but ${c.holder} has it.`))) : null,
      links.length ? group('Development links', links.map((l) => line(`${l.name} (${l.commands.join(', ') || 'no commands'})`, button('Remove', () => act(() => k('commandUnlink', l.path), 'The link was removed.'), 'danger', { 'aria-label': `Remove link ${l.path}` }),
        `${l.path}${l.broken ? ` · broken: ${l.reason ?? 'the project is missing'}` : ''}`))) : null,
      h('section', null, h('h2', null, 'Services'), services.length ? listEl : h('div', { class: 'group' }, line('No services are installed.', null, 'A service is a program that runs in the background.')))))

    return [body]
  }
}
