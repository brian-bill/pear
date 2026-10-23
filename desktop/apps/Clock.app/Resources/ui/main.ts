/// Clock app entry. Tabs (World / Timer / Stopwatch), window menus with Cmd+1..3 shortcuts, Enter as the
/// timer's start key, and one shared rule: every interval and rAF loop pauses when the document is
/// hidden (`visibilitychange`) and catches up on resume.
import { tiny } from '@tiny/sdk'
import { createWorld } from './world'
import { createCountdown, type TimerSave } from './countdown'
import { createStopwatch } from './stopwatch'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const TABS = ['world', 'timer', 'stopwatch'] as const
type Tab = (typeof TABS)[number]

interface Saved {
  tab?: Tab
  timer?: TimerSave
}

const isTab = (v: unknown): v is Tab => typeof v === 'string' && (TABS as readonly string[]).includes(v)

async function main(): Promise<void> {
  await tiny.ready

  let tab: Tab = 'world'

  function setTab(next: Tab): void {
    tab = next
    for (const t of TABS) {
      $(`tab-${t}`).setAttribute('aria-selected', String(t === tab))
      $(`view-${t}`).toggleAttribute('hidden', t !== tab)
    }
    if (tab === 'stopwatch') stopwatch.activate()
    else stopwatch.deactivate()
  }

  const world = createWorld($('cities'), $<HTMLInputElement>('city-query'), $('city-results'))
  const saved = (tiny.app.state ?? {}) as Saved
  if (isTab(saved.tab)) tab = saved.tab
  const countdown = createCountdown($('view-timer'), saved.timer)
  const stopwatch = createStopwatch($('view-stopwatch'))

  /** One place for the away rule: when the window is hidden every redraw falls silent. */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      world.pause()
      countdown.pause()
      stopwatch.pause()
    } else {
      world.resume()
      countdown.resume()
      stopwatch.resume()
    }
  })

  setTab(tab)

  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const target = e.target
    const onTabButton = target instanceof HTMLElement && target.closest('[role="tablist"]') !== null
    if (onTabButton && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const tabs = TABS.map((t) => $(`tab-${t}`))
      const i = tabs.indexOf(target as HTMLElement)
      if (i >= 0) {
        tabs[(i + TABS.length + (e.key === 'ArrowLeft' ? -1 : 1)) % TABS.length]?.focus()
        e.preventDefault()
        return
      }
    }
    if (e.key !== 'Enter') return
    if (target === $<HTMLInputElement>('city-query')) {
      world.pickFirst()
      e.preventDefault()
      return
    }
    if (tab === 'timer') {
      countdown.advance()
      e.preventDefault()
    }
  })

  for (const t of TABS) $(`tab-${t}`).addEventListener('click', () => setTab(t))

  tiny.app.onSaveState((): Saved => ({ tab, timer: countdown.snapshot() }))
  void tiny.window.setMenus([
    { title: 'Clock', items: [{ label: 'About Clock', action: about }] },
    {
      title: 'View',
      items: [
        { label: 'World', shortcut: 'Cmd+1', action: () => setTab('world') },
        { label: 'Timer', shortcut: 'Cmd+2', action: () => setTab('timer') },
        { label: 'Stopwatch', shortcut: 'Cmd+3', action: () => setTab('stopwatch') },
      ],
    },
  ])
}

function about(): void {
  void tiny.dialogs.alert({ message: 'Clock', detail: 'World clocks, a timer and a stopwatch. Version 1.0.0.' })
}

void main()
