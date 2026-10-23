/// Small DOM and settings helpers shared by every pane.
import { tiny } from '@tiny/sdk'

export type Child = Node | string | number | null | false | undefined | Child[]

/** Make an element. Props starting with `on` are listeners; `class`, `value`, `checked` and `disabled` are set as properties. */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'class') el.className = String(v)
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'min' || k === 'max' || k === 'step') (el as unknown as Record<string, unknown>)[k] = v
    else el.setAttribute(k, v === true ? '' : String(v))
  }
  const add = (c: Child): void => {
    if (Array.isArray(c)) c.forEach(add)
    else if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c))
  }
  kids.forEach(add)
  return el
}

// ---- settings

export type Json = string | number | boolean | null | Json[] | { [k: string]: Json }

/** Every effective value of a settings domain. */
export const cfgList = (domain: string) => tiny.admin.kernel<Record<string, any>>('configList', domain)

/** Write a setting and make it durable at once. */
export async function cfgSet(domain: string, key: string, value: Json): Promise<void> {
  await tiny.admin.kernel('configSet', domain, key, value)
  await tiny.admin.kernel('configFlush')
}

export const sys = <T = any>(name: string, msg: Record<string, unknown>) => tiny.admin.service<T>(name, msg)

// ---- feedback

let statusEl: HTMLElement | null = null
export function bindStatus(el: HTMLElement): void {
  statusEl = el
}

/** Show a message in the pane's status line. */
export function say(msg: string, error = false): void {
  if (!statusEl) return
  statusEl.textContent = msg
  statusEl.classList.toggle('error', error)
}

/** Run an action; report a failure in the status line instead of throwing. */
export async function attempt<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn()
    if (ok) say(ok)
    return r
  } catch (e) {
    say(`${(e as Error).message || 'Failed'}${(e as { code?: string }).code ? ` (${(e as { code?: string }).code})` : ''}`, true)
    return undefined
  }
}

// ---- layout

/** A titled card of lines. */
export function group(title: string | null, ...lines: Child[]): HTMLElement {
  return h('section', null, title ? h('h2', null, title) : null, h('div', { class: 'group' }, lines))
}

/** One line: a label (with optional hint) on the left, controls on the right. */
export function line(label: string, control?: Child, hint?: string): HTMLElement {
  return h('div', { class: 'line' }, h('div', { class: 'label' }, label, hint ? h('small', null, hint) : null), control ? h('div', { class: 'ctl' }, control) : null)
}

/** A label with a read-only value. */
export const info = (label: string, value: string): HTMLElement => line(label, h('span', { class: 'val' }, value))

// ---- controls

export function toggle(label: string, checked: boolean, onChange: (on: boolean) => void | Promise<unknown>): HTMLInputElement {
  return h('input', { type: 'checkbox', class: 'switch', role: 'switch', 'aria-label': label, checked, onchange: (e: Event) => void onChange((e.target as HTMLInputElement).checked) })
}

export function choose<T extends string | number>(label: string, options: Array<[T, string]>, value: T, onChange: (v: T) => void | Promise<unknown>): HTMLSelectElement {
  const sel = h('select', { 'aria-label': label, onchange: (e: Event) => {
    const raw = (e.target as HTMLSelectElement).value
    void onChange((typeof value === 'number' ? Number(raw) : raw) as T)
  } }, options.map(([v, text]) => h('option', { value: String(v) }, text)))
  sel.value = String(value)
  if (sel.value !== String(value)) sel.append(h('option', { value: String(value), selected: true }, String(value)))
  sel.value = String(value)
  return sel
}

export function segmented<T extends string>(label: string, options: Array<[T, string]>, value: T, onChange: (v: T) => void | Promise<unknown>): HTMLElement {
  const box = h('div', { class: 'segmented', role: 'group', 'aria-label': label })
  const paint = (v: T) => box.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)))
  for (const [v, text] of options) {
    box.append(h('button', { type: 'button', 'data-value': v, 'aria-pressed': String(v === value), onclick: () => {
      paint(v)
      void onChange(v)
    } }, text))
  }
  return box
}

export function slider(label: string, o: { min: number; max: number; step: number; value: number }, onChange: (v: number) => void | Promise<unknown>, format?: (v: number) => string): HTMLElement {
  const out = h('span', { class: 'dim', style: 'min-width:42px;text-align:right' }, format ? format(o.value) : String(o.value))
  const input = h('input', { type: 'range', min: o.min, max: o.max, step: o.step, value: o.value, 'aria-label': label,
    oninput: () => (out.textContent = format ? format(Number(input.value)) : input.value),
    onchange: () => void onChange(Number(input.value)) })
  input.value = String(o.value)
  return h('span', { class: 'row' }, input, out)
}

export const button = (label: string, onClick: () => void | Promise<unknown>, cls = '', extra: Record<string, unknown> = {}): HTMLButtonElement =>
  h('button', { type: 'button', class: cls, onclick: () => void onClick(), ...extra }, label)

// ---- apps

export interface AppEntry { id: string; name: string; icon: string | null; kind: string }

let appsCache: Promise<AppEntry[]> | null = null
/** Installed apps (not services or tools), fresh once per pane render. */
export function apps(fresh = false): Promise<AppEntry[]> {
  if (fresh || !appsCache) appsCache = tiny.shell.apps().then((a) => a.filter((x) => x.kind === 'app'))
  return appsCache
}

export function appLabel(a: { id: string; name: string; icon?: string | null }): HTMLElement {
  return h('span', { class: 'app-name' }, a.icon ? h('img', { src: a.icon, alt: '' }) : null, a.name)
}

export const nameOf = (list: AppEntry[], id: string): string => list.find((a) => a.id === id)?.name ?? id

// ---- panes

export interface Pane {
  id: string
  title: string
  /** Emoji shown in the sidebar tile. */
  icon: string
  color: string
  /** Extra words the sidebar search matches. */
  keywords: string
  render(root: HTMLElement): Promise<void> | void
}
