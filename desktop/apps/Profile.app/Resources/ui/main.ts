// Profile — Brian Omondi's portfolio, résumé and contact card. The first page is about Pear and Vanilla.
import { tiny } from '@tiny/sdk'

type Page = 'project' | 'resume' | 'contact'
type Snapshot = {
  version: { name?: string; version?: string; kernel?: string }
  hardware?: { cores?: number | null }
  storage?: { usage?: number | null; quota?: number | null }
  uptime?: number
  hostname?: string
}

const pages = [...document.querySelectorAll<HTMLElement>('.page[data-page]')]
const navItems = [...document.querySelectorAll<HTMLButtonElement>('.nav-item[data-page]')]
const main = document.getElementById('main')!
const toastEl = document.getElementById('toast')!
let page: Page = 'project'
let toastTimer: number | undefined

const isPage = (value: unknown): value is Page => value === 'project' || value === 'resume' || value === 'contact'
const $ = (id: string) => document.getElementById(id)
const setText = (id: string, value: string) => {
  const el = $(id)
  if (el) el.textContent = value
}

/** Paint the page without touching the saved state (used at boot). */
function applyPage(next: Page): void {
  page = next
  for (const section of pages) {
    const active = section.dataset.page === next
    section.hidden = !active
    section.classList.toggle('is-active', active)
  }
  for (const item of navItems) {
    if (item.dataset.page === next) item.setAttribute('aria-current', 'page')
    else item.removeAttribute('aria-current')
  }
}

function showPage(next: Page): void {
  if (next === page) {
    main.scrollTo({ top: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' })
    return
  }
  applyPage(next)
  main.scrollTo({ top: 0, behavior: 'auto' })
  void tiny.app.stateChanged()
}

const prefersReducedMotion = () => document.documentElement.dataset.reduceMotion === 'true' || matchMedia('(prefers-reduced-motion: reduce)').matches

function toast(text: string): void {
  toastEl.textContent = text
  toastEl.hidden = false
  requestAnimationFrame(() => toastEl.classList.add('visible'))
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toastEl.classList.remove('visible')
    window.setTimeout(() => (toastEl.hidden = true), 180)
  }, 1800)
}

async function copy(text: string, label = 'Text'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast(`${label} copied`)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
    document.body.append(area)
    area.select()
    try {
      if (!document.execCommand('copy')) throw new Error('copy failed')
      toast(`${label} copied`)
    } catch {
      toast(text)
    } finally {
      area.remove()
    }
  }
}

async function openUrl(url: string): Promise<void> {
  try {
    await tiny.shell.open(url)
  } catch {
    toast(`Could not open ${url}`)
  }
}

function scrollToSection(id: string): void {
  if (page !== 'project') applyPage('project')
  const target = document.getElementById(id)
  if (!target) return
  requestAnimationFrame(() => target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' }))
}

// ---- system information: the Profile window is running on the thing it describes

const bytes = (n: number | null | undefined): string => {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '—'
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`
  return `${Math.round(n / 1e3)} KB`
}

const uptime = (ms: number | undefined): string => {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '—'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 60) return `${minutes} min`
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

async function loadSystem(): Promise<void> {
  try {
    const info = (await tiny.system.info('snapshot')) as Snapshot
    const name = info.version?.name ?? 'Pear'
    const version = info.version?.version ?? ''
    const kernel = info.version?.kernel ?? 'Vanilla'
    setText('live-version', `${name}${version ? ` ${version}` : ''}`)
    setText('live-kernel', kernel)
    setText('live-cores', info.hardware?.cores ? `${info.hardware.cores} cores` : '—')
    setText('live-storage', `${bytes(info.storage?.usage)} of ${bytes(info.storage?.quota)}`)
    setText('live-uptime', uptime(info.uptime))
    setText('rail-system', `${name} is running`)
    setText('rail-detail', `${kernel} · ${info.hostname ?? 'in your browser'}`)
  } catch {
    setText('rail-system', 'Pear is running')
    setText('rail-detail', 'Vanilla · in your browser')
  }
}

// ---- clicks

document.addEventListener('click', (event) => {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-copy], [data-url], [data-scroll], [data-goto], [data-page]')
  if (!target) return

  const copied = target.dataset.copy
  if (copied !== undefined) {
    event.preventDefault()
    void copy(copied, target.dataset.label ?? 'Text')
    return
  }

  const url = target.dataset.url
  if (url !== undefined) {
    event.preventDefault()
    void openUrl(url)
    return
  }

  const section = target.dataset.scroll
  if (section !== undefined) {
    event.preventDefault()
    scrollToSection(section)
    return
  }

  const next = target.dataset.goto ?? target.dataset.page
  if (isPage(next)) {
    event.preventDefault()
    showPage(next)
  }
})

// ---- boot

void (async () => {
  await tiny.ready

  const saved = (tiny.app.state as { page?: unknown } | null | undefined)?.page
  if (isPage(saved)) applyPage(saved)
  else applyPage('project')

  tiny.app.onSaveState(() => ({ page }))
  await tiny.window.setMenus([
    {
      title: 'Profile',
      items: [
        { label: 'About This Pear', action: () => void tiny.shell.openApp('org.tiny.about') },
        { separator: true },
        { label: 'The Project', shortcut: '⌘1', action: () => showPage('project') },
        { label: 'Résumé', shortcut: '⌘2', action: () => showPage('resume') },
        { label: 'Contact', shortcut: '⌘3', action: () => showPage('contact') },
        { separator: true },
        { label: 'Copy Email', action: () => void copy('brian@omondi.dev', 'Email') },
      ],
    },
  ])

  void loadSystem()
})()
