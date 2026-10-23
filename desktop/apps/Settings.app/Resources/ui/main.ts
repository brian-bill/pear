import { tiny } from '@tiny/sdk'
import { bindStatus, h, type Pane } from './lib'
import { accessibility } from './panes/accessibility'
import { appsPane } from './panes/apps'
import { appearance } from './panes/appearance'
import { desktop } from './panes/desktop'
import { displays } from './panes/displays'
import { general } from './panes/general'
import { keyboard } from './panes/keyboard'
import { language } from './panes/language'
import { network } from './panes/network'
import { notifications } from './panes/notifications'
import { power } from './panes/power'
import { privacy } from './panes/privacy'
import { sound } from './panes/sound'

const PANES: Pane[] = [general, appearance, desktop, displays, sound, keyboard, language, notifications, privacy, network, appsPane, accessibility, power]

const listEl = document.getElementById('panes')!
const paneEl = document.getElementById('pane')!
const titleEl = document.getElementById('title')!
const status = h('div', { class: 'status', role: 'status' })
bindStatus(status)
const search = document.getElementById('search') as HTMLInputElement
let current = PANES[0]!
let drawing = 0

/** Show a pane, re-reading its settings. */
async function show(pane: Pane): Promise<void> {
  current = pane
  const mine = ++drawing
  titleEl.textContent = pane.title
  for (const b of listEl.querySelectorAll<HTMLElement>('.item')) {
    const on = b.dataset.pane === pane.id
    b.classList.toggle('selected', on)
    if (on) b.setAttribute('aria-current', 'true')
    else b.removeAttribute('aria-current')
  }
  const body = h('div', { class: 'pane-body', 'data-pane': pane.id })
  try {
    await pane.render(body)
  } catch (e) {
    body.replaceChildren(h('p', { class: 'status error' }, `${pane.title} could not be loaded: ${(e as Error).message}`))
  }
  if (mine !== drawing) return // another pane was chosen meanwhile
  paneEl.replaceChildren(body, status)
  paneEl.scrollTop = 0
}

function drawList(): void {
  const q = search.value.trim().toLowerCase()
  const shown = PANES.filter((p) => !q || `${p.title} ${p.keywords}`.toLowerCase().includes(q))
  listEl.replaceChildren(...(shown.length ? shown.map((p) => h('button', { type: 'button', class: `item${p === current ? ' selected' : ''}`, 'data-pane': p.id, role: 'listitem', 'aria-current': p === current ? 'true' : null, onclick: () => void show(p) },
    h('span', { class: 'tile', style: `background:${p.color};color:#fff` }, p.icon), p.title)) : [h('div', { class: 'empty' }, 'No results')]))
}

/** `pane:appearance` or just `appearance`. */
function openPane(id: unknown): void {
  const name = String(id ?? '').replace(/^pane:/, '')
  const pane = PANES.find((p) => p.id === name)
  if (!pane) return
  search.value = ''
  drawList()
  void show(pane)
}

async function main(): Promise<void> {
  await tiny.ready
  const saved = tiny.app.state as { pane?: string } | null
  const wanted = tiny.app.args.find((a) => a.startsWith('pane:'))?.slice(5) ?? saved?.pane
  current = PANES.find((p) => p.id === wanted) ?? PANES[0]!
  drawList()
  search.addEventListener('input', () => {
    drawList()
  })
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return
    const first = PANES.find((p) => `${p.title} ${p.keywords}`.toLowerCase().includes(search.value.trim().toLowerCase()))
    if (first) void show(first).then(drawList)
  })
  tiny.app.onSaveState(() => ({ pane: current.id }))
  tiny.on('openPane', openPane)
  tiny.on('openURL', (u) => openPane(String(u).replace(/^.*:\/*/, '')))
  // changes made elsewhere show up when the window is used again
  tiny.on('focus', () => {
    if (!document.activeElement?.matches('input, select, textarea')) void show(current)
  })
  tiny.window.setMenus([{ title: 'System Settings', items: [{ label: 'About System Settings', action: () => void tiny.dialogs.alert({ message: 'System Settings', detail: 'Change how Pear looks and behaves.' }) }] }])
  await show(current)
}
void main()
