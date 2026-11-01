// The debug console: what the previewed app writes with `console.*`, its uncaught errors, and a
// prompt that evaluates expressions inside the running app. Values arrive from the preview shim as
// small trees (shim.ts `ser`) and render as expandable objects, like browser dev tools.
import { icon } from './icons'

export type Ser =
  | { k: 'prim'; t: string; v: string }
  | { k: 'fn'; v: string }
  | { k: 'node'; v: string }
  | { k: 'err'; name: string; v: string; stack: string }
  | { k: 'obj'; cls: string; len?: number; props: Array<[string, Ser]>; more: number }
  | { k: 'circ' }

export type Level = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'result' | 'input'

export interface EvalReply {
  ok: boolean
  value: Ser
}

const MAX_ROWS = 1000

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

/** One line of preview text for a value, as shown beside the disclosure triangle. */
function summary(v: Ser, nested: boolean): string {
  switch (v.k) {
    case 'prim':
      return v.t === 'string' && nested ? JSON.stringify(v.v.length > 60 ? v.v.slice(0, 60) + '…' : v.v) : v.v
    case 'fn':
    case 'node':
      return v.v
    case 'err':
      return `${v.name}: ${v.v}`
    case 'circ':
      return '[Circular]'
    case 'obj': {
      const arrayish = v.cls === 'Array'
      const head = arrayish ? `(${v.len ?? v.props.length}) ` : v.cls === 'Object' ? '' : v.len !== undefined ? `${v.cls}(${v.len}) ` : `${v.cls} `
      if (!v.props.length) return `${head}${arrayish ? '[]' : '{}'}${v.more ? '…' : ''}`
      const shown = v.props.slice(0, arrayish ? 6 : 4).map(([k, val]) => (arrayish ? summary(val, true) : `${k}: ${summary(val, true)}`))
      const rest = v.props.length - shown.length + v.more
      return `${head}${arrayish ? '[' : '{'}${shown.join(', ')}${rest > 0 ? ', …' : ''}${arrayish ? ']' : '}'}`
    }
  }
}

function renderValue(v: Ser, nested = false): HTMLElement {
  if (v.k === 'prim') return el('span', `v v-${v.t}`, v.t === 'string' && (nested || v.v === '') ? JSON.stringify(v.v) : v.v)
  if (v.k === 'fn') return el('span', 'v v-fn', v.v)
  if (v.k === 'node') return el('span', 'v v-node', v.v)
  if (v.k === 'circ') return el('span', 'v v-dim', '[Circular]')
  if (v.k === 'err') {
    const box = el('span', 'v v-err')
    const head = el('span', 'errhead', `${v.name}: ${v.v}`)
    box.append(head)
    const lines = v.stack.split('\n').filter((l) => l.trim() && !l.startsWith(`${v.name}:`))
    if (lines.length) {
      const stack = el('span', 'stack', lines.join('\n'))
      stack.hidden = true
      head.classList.add('expandable')
      head.addEventListener('click', () => (stack.hidden = !stack.hidden))
      box.append(stack)
    }
    return box
  }
  // an object: a triangle, a one-line summary, and its properties once opened
  const box = el('span', 'v v-obj')
  const line = el('span', 'objline')
  const twist = el('span', 'twist')
  twist.innerHTML = icon('chevron-right', 12)
  line.append(twist, el('span', 'objsum', summary(v, nested)))
  const children = el('span', 'children')
  children.hidden = true
  let built = false
  line.addEventListener('click', () => {
    if (!built) {
      built = true
      for (const [k, val] of v.props) {
        const row = el('span', 'prop')
        row.append(el('span', 'k', k), el('span', 'colon', ': '), renderValue(val, true))
        children.append(row)
      }
      if (v.more) children.append(el('span', 'prop more', `… ${v.more} more`))
      if (!v.props.length && !v.more) children.append(el('span', 'prop more', 'empty'))
    }
    children.hidden = !children.hidden
    twist.innerHTML = icon(children.hidden ? 'chevron-right' : 'chevron-down', 12)
  })
  box.append(line, children)
  return box
}

interface Mount {
  log: HTMLElement
  input: HTMLInputElement
  filter: HTMLSelectElement
  badge: HTMLElement
  /** Called on the first error after a (re)load, so the panel can come forward. */
  onError(): void
}

let m: Mount | null = null
let errors = 0
let announced = false
let last: { sig: string; row: HTMLElement; count: number } | null = null
const history: string[] = []
let cursor = 0

/** The prompt's evaluator: runs code in the previewed app. Resolves null when no preview is running. */
export let evaluator: ((code: string) => Promise<EvalReply | null>) | null = null
export const setEvaluator = (fn: typeof evaluator): void => void (evaluator = fn)

function trim(): void {
  while (m && m.log.childElementCount > MAX_ROWS) m.log.firstElementChild?.remove()
}

function updateBadge(): void {
  if (!m) return
  m.badge.hidden = errors === 0
  m.badge.textContent = String(errors)
}

export function add(level: Level, args: Ser[], where = ''): void {
  if (!m) return
  const row = el('div', `crow lvl-${level}`)
  row.role = 'listitem'
  const gutter = el('span', 'cgutter')
  if (level === 'error') gutter.innerHTML = icon('error', 14)
  else if (level === 'warn') gutter.innerHTML = icon('warning', 14)
  else if (level === 'input') gutter.innerHTML = icon('chevron-right', 14)
  else if (level === 'result') gutter.innerHTML = icon('chevron-left', 14)
  const body = el('span', 'cbody')
  args.forEach((a, i) => {
    if (i) body.append(' ')
    body.append(renderValue(a, false))
  })
  row.append(gutter, body)
  if (where) row.append(el('span', 'cwhere', where))

  // the same message again and again becomes one row with a count
  const sig = level + JSON.stringify(args)
  if (last && last.sig === sig && level !== 'input' && level !== 'result') {
    last.count++
    let n = last.row.querySelector('.ccount')
    if (!n) {
      n = el('span', 'ccount')
      last.row.prepend(n)
    }
    n.textContent = String(last.count)
  } else {
    m.log.append(row)
    last = { sig, row, count: 1 }
    trim()
  }
  if (level === 'error') {
    errors++
    updateBadge()
    if (!announced) {
      announced = true
      m.onError()
    }
  }
  m.log.scrollTop = m.log.scrollHeight
}

/** A divider where the previewed page was rebuilt; the log before it is kept. */
export function separator(text: string): void {
  if (!m) return
  last = null
  announced = false
  const row = el('div', 'csep')
  row.append(el('span', undefined, text))
  m.log.append(row)
  trim()
}

export function clear(): void {
  if (!m) return
  m.log.replaceChildren()
  last = null
  errors = 0
  announced = false
  updateBadge()
}

async function submit(): Promise<void> {
  if (!m) return
  const code = m.input.value.trim()
  if (!code) return
  m.input.value = ''
  if (history[history.length - 1] !== code) history.push(code)
  cursor = history.length
  add('input', [{ k: 'prim', t: 'code', v: code }])
  const reply = evaluator ? await evaluator(code) : null
  if (!reply) add('warn', [{ k: 'prim', t: 'string', v: 'No preview is running. Open the preview to evaluate code in the app.' }])
  else add(reply.ok ? 'result' : 'error', [reply.value])
}

export function mount(parts: Mount): void {
  m = parts
  parts.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void submit()
    } else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault()
      cursor = Math.max(0, cursor - 1)
      parts.input.value = history[cursor] ?? ''
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      cursor = Math.min(history.length, cursor + 1)
      parts.input.value = history[cursor] ?? ''
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault()
      clear()
    }
  })
  parts.filter.addEventListener('change', () => (parts.log.dataset.filter = parts.filter.value))
  parts.log.dataset.filter = 'all'
  updateBadge()
}
