import { tiny } from '@tiny/sdk'
import { auditPane } from './audit'
import { crashPane } from './crashes'
import { logPane } from './logpane'
import { LogStore } from './store'
import type { Pane } from './types'
import { el, esc } from './util'

type Section = 'all' | 'errors' | 'crashes' | 'audit'

async function main(): Promise<void> {
  await tiny.ready
  const store = new LogStore()
  const sidebar = document.getElementById('sidebar')!
  const content = document.getElementById('content')!
  let crashCount = 0

  const log = logPane(store, () => facets())
  const crashes = crashPane((n) => {
    if (n !== crashCount) {
      crashCount = n
      facets()
    }
  })
  const audit = auditPane()
  const panes: Record<Section, Pane> = { all: log, errors: log, crashes, audit }
  for (const p of new Set(Object.values(panes))) content.append(p.el)

  let section: Section = 'all'

  function go(s: Section): void {
    section = s
    if (s === 'all' || s === 'errors') {
      store.filter.section = s
      log.refilter()
    }
    for (const p of new Set(Object.values(panes))) p.el.classList.toggle('on', p === panes[s])
    panes[s].show()
    facets()
  }

  function facets(): void {
    const item = (id: string, label: string, on: boolean, extra = '') => `<button class="item" data-go="${esc(id)}" aria-current="${on}">${esc(label)}${extra}</button>`
    const subs = [...store.subsystems].sort((a, b) => a[0].localeCompare(b[0]))
    sidebar.innerHTML = `
      <h4>Log</h4>
      ${item('all', 'All Messages', section === 'all' && !store.filter.subsystem)}
      ${item('errors', 'Errors and Faults', section === 'errors')}
      <h4>Reports</h4>
      ${item('crashes', 'Crash Reports', section === 'crashes', crashCount ? `<span class="badge">${crashCount}</span>` : '')}
      ${item('audit', 'Audit', section === 'audit')}
      <h4>Subsystems</h4>
      ${subs.map(([name, n]) => `<button class="item sub" data-sub="${esc(name)}" aria-current="${store.filter.subsystem === name && (section === 'all' || section === 'errors')}" title="${esc(name)}"><span class="grow ellipsis">${esc(name)}</span><span class="dim">${n}</span></button>`).join('') || '<div class="dim" style="padding:2px 8px">None yet</div>'}`
  }

  sidebar.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('button')
    if (!b) return
    if (b.dataset.go) {
      if (b.dataset.go === 'all') store.filter.subsystem = null
      go(b.dataset.go as Section)
    } else if (b.dataset.sub !== undefined) {
      const same = store.filter.subsystem === b.dataset.sub
      store.filter.subsystem = same ? null : b.dataset.sub
      go(section === 'errors' ? 'errors' : 'all')
    }
  })

  void tiny.window.setMenus([
    { title: 'Console', items: [{ label: 'Find', shortcut: 'Cmd+F', action: () => document.querySelector<HTMLInputElement>('#q')?.focus() }] },
  ])

  await tiny.admin.kernel('logWrite', { subsystem: 'desktop.console', message: 'Console opened' }).catch(() => {})
  await Promise.resolve(log.tick()).catch(() => {})
  await crashes.load()
  go('all')

  let n = 0
  setInterval(() => {
    if (document.hidden) return
    n++
    void Promise.resolve(log.tick()).catch(() => {})
    // slower things: the crash badge always, the shown report list or audit when they are open
    if (n % 2 === 0) {
      if (section === 'crashes') void crashes.tick()
      else void crashes.load()
      if (section === 'audit') void audit.tick()
    }
  }, 1000)
}
void main()
