import { tiny } from '@tiny/sdk'
import { diskTab } from './disk'
import { energyTab } from './energy'
import { history } from './history'
import { memoryTab } from './memory'
import { networkTab } from './network'
import { processesTab } from './processes'
import type { Diagnostics, ProcessInfo, Sample, Tab } from './types'

const REFRESH_MS = 2000

async function main(): Promise<void> {
  await tiny.ready
  const procTab = processesTab()
  const tabs: Tab[] = [procTab, memoryTab(), energyTab(), networkTab(), diskTab()]
  const bar = document.getElementById('tabs')!
  const panels = document.getElementById('panels')!
  const updated = document.getElementById('updated')!
  const appNames = new Map<string, string>()
  let active = tabs[0]!
  let last: Sample | null = null
  let busy = false

  for (const t of tabs) {
    const b = Object.assign(document.createElement('button'), { textContent: t.title })
    b.setAttribute('role', 'tab')
    b.dataset.tab = t.id
    b.addEventListener('click', () => show(t))
    bar.append(b)
    panels.append(t.el)
  }
  function show(t: Tab): void {
    active = t
    for (const b of bar.querySelectorAll('button')) {
      const on = (b as HTMLElement).dataset.tab === t.id
      b.setAttribute('aria-pressed', String(on))
      b.setAttribute('aria-selected', String(on))
    }
    for (const x of tabs) x.el.classList.toggle('on', x === t)
    if (last) void t.update(last)
  }

  async function refresh(): Promise<void> {
    if (busy) return
    busy = true
    try {
      const [snap, procs] = await Promise.all([tiny.admin.kernel<Diagnostics>('diagSnapshot'), tiny.admin.kernel<ProcessInfo[]>('listProcesses')])
      last = { now: Date.now(), snap, procs, appNames }
      history.push(snap.memory?.usedJSHeapSize ?? null, procs.length)
      updated.textContent = `Updated ${new Date().toLocaleTimeString()}`
      await active.update(last)
    } catch (e) {
      updated.textContent = `Refresh failed: ${(e as Error).message}`
    } finally {
      busy = false
    }
  }

  void tiny.shell.apps().then((apps) => {
    for (const a of apps) appNames.set(a.id, a.name)
  }).catch(() => {})
  procTab.onRefresh(() => void refresh())

  show(active)
  void tiny.window.setMenus([
    { title: 'Activity Monitor', items: [{ label: 'Refresh Now', shortcut: 'Cmd+R', action: () => void refresh() }] },
  ])
  await refresh()
  // no refresh while the window is hidden (minimized, or another tab of the browser)
  setInterval(() => {
    if (!document.hidden) void refresh()
  }, REFRESH_MS)
}
void main()
