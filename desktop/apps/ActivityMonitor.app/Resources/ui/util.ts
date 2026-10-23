import { escapeHtml, formatBytes } from '@tiny/sdk'
import type { Sample } from './types'

export { escapeHtml, formatBytes }

export const esc = escapeHtml

export function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`
}

export const userName = (uid: number) => (uid === 0 ? 'root' : uid === 501 ? 'pear' : String(uid))

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** A display name for an app id (`org.tiny.terminal` -> Terminal), or the id itself. */
export const appLabel = (s: Sample, id: string | null) => (id ? (s.appNames.get(id) ?? id) : '')

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}

/** A grid of labelled values whose text can be updated by key. */
export function statGrid(items: Array<[key: string, label: string]>, small = false) {
  const root = el('div', 'grid')
  const vals = new Map<string, HTMLElement>()
  for (const [key, label] of items) {
    const box = el('div', 'card stat', `<span class="k">${esc(label)}</span><span class="v${small ? ' small' : ''} selectable"></span>`)
    vals.set(key, box.querySelector('.v')!)
    root.append(box)
  }
  return { el: root, set: (key: string, text: string) => void (vals.get(key)!.textContent = text) }
}
