import { tiny } from '@tiny/sdk'
import { evaluate, format, ExprError, type AngleMode } from './expr'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const exprEl = $('expr')
const previewEl = $('preview')
const pad = $('pad')

interface Entry { expr: string; result: string }
let expr = ''
let result: string | null = null // set right after "="; typing a digit then starts over
let angle: AngleMode = 'deg'
let sci = false
let history: Entry[] = []
let error = ''

type Key = { label: string; send: string; cls?: string; title?: string; action?: () => void }
const K = (label: string, send = label, cls = 'num'): Key => ({ label, send, cls })

const BASIC: Key[] = [
  { label: 'AC', send: '', cls: '', action: clearAll }, { label: '⌫', send: '', cls: '', action: backspace }, K('%', '%', ''), K('÷', '÷', 'op'),
  K('7'), K('8'), K('9'), K('×', '×', 'op'),
  K('4'), K('5'), K('6'), K('−', '−', 'op'),
  K('1'), K('2'), K('3'), K('+', '+', 'op'),
  { ...K('0'), cls: 'num span2' }, K('.'), { label: '=', send: '', cls: 'op', action: equals },
]
const SCI: Key[] = [
  K('(', '(', 'fn'), K(')', ')', 'fn'), K('x²', '^2', 'fn'), K('xʸ', '^', 'fn'), K('n!', '!', 'fn'),
  K('sin', 'sin(', 'fn'), K('cos', 'cos(', 'fn'), K('tan', 'tan(', 'fn'), K('π', 'π', 'fn'), K('e', 'e', 'fn'),
  K('ln', 'ln(', 'fn'), K('log', 'log(', 'fn'), K('√', 'sqrt(', 'fn'), K('eˣ', 'exp(', 'fn'), K('1/x', '', 'fn'),
]

function buildPad(): void {
  const make = (keys: Key[], cols: number) => {
    const g = document.createElement('div')
    g.className = 'grid'
    g.style.gridTemplateColumns = `repeat(${cols}, 1fr)`
    g.style.flex = cols === 5 ? '3' : '5'
    g.append(...keys.map(button))
    return g
  }
  pad.replaceChildren(...(sci ? [make(SCI, 5)] : []), make(BASIC, 4))
}

function button(k: Key): HTMLButtonElement {
  const b = document.createElement('button')
  b.textContent = k.label
  b.className = k.cls ?? ''
  b.setAttribute('aria-label', ({ '÷': 'divide', '×': 'multiply', '−': 'subtract', '+': 'add', '=': 'equals', '⌫': 'delete', AC: 'all clear' } as Record<string, string>)[k.label] ?? k.label)
  b.tabIndex = -1
  b.addEventListener('click', () => (k.action ? k.action() : k.label === '1/x' ? reciprocal() : press(k.send)))
  return b
}

const isOperator = (s: string) => /^[+\-−×÷^%!]/.test(s)

function press(s: string): void {
  error = ''
  if (result !== null) {
    // after "=": an operator continues with the result, anything else starts a new calculation
    expr = /^[+\-−×÷^%!]/.test(s) ? result : ''
    result = null
  }
  // a second operator replaces the first one (but a minus may follow × ÷ ^ as a sign)
  if (/^[+−×÷^]$/.test(s) && /[+−×÷^]$/.test(expr) && !(s === '−' && /[×÷^]$/.test(expr))) expr = expr.slice(0, -1)
  if (isOperator(s) && !/^[−(]/.test(s) && (expr === '' || /\($/.test(expr)) && s !== '−') return
  expr += s
  render()
}

function normalizeKey(k: string): string {
  return k === '*' ? '×' : k === '/' ? '÷' : k === '-' ? '−' : k
}

function backspace(): void {
  if (result !== null) return clearAll()
  expr = expr.replace(/(?:sin|cos|tan|ln|log|sqrt|exp)\($|.$/u, '')
  error = ''
  render()
}

function clearAll(): void {
  expr = ''
  result = null
  error = ''
  render()
}

function reciprocal(): void {
  const cur = result ?? expr
  if (!cur) return
  expr = `1÷(${cur})`
  result = null
  equals()
}

function compute(src: string): string | null {
  if (!src) return null
  try {
    return format(evaluate(src, angle))
  } catch (e) {
    if (e instanceof ExprError) return null
    throw e
  }
}

function equals(): void {
  if (!expr) return
  try {
    const r = format(evaluate(expr, angle))
    history.unshift({ expr, result: r })
    history = history.slice(0, 100)
    previewEl.textContent = `${expr} =`
    expr = r
    result = r
    error = ''
    renderHistory()
    exprEl.textContent = r
    fit()
  } catch (e) {
    error = e instanceof ExprError ? e.message : 'Error'
    render()
  }
}

function fit(): void {
  exprEl.classList.toggle('long', exprEl.textContent!.length > 11)
}

function render(): void {
  exprEl.textContent = error ? 'Error' : expr || '0'
  const live = error ? error : compute(expr)
  previewEl.textContent = error ? error : live && live !== expr ? `= ${live}` : ''
  fit()
}

function renderHistory(): void {
  const items = $('items')
  items.replaceChildren(
    ...history.map((h) => {
      const d = document.createElement('div')
      const small = document.createElement('small')
      small.textContent = h.expr
      d.append(small, h.result)
      d.title = 'Use this result'
      d.addEventListener('click', () => {
        expr = h.result
        result = h.result
        toggleTape(false)
        render()
      })
      return d
    }),
  )
  if (!history.length) items.textContent = 'No history yet'
}

function toggleTape(on: boolean): void {
  $('history').hidden = !on
  $('tape').setAttribute('aria-pressed', String(on))
}

async function copyResult(): Promise<void> {
  const text = result ?? compute(expr) ?? expr
  if (!text) return
  try {
    await tiny.service('tiny.clipboard', { op: 'write', items: [{ type: 'public.utf8-plain-text', data: text }] })
    previewEl.textContent = 'Copied'
  } catch {
    previewEl.textContent = 'Could not copy'
  }
}

async function pasteNumber(): Promise<void> {
  try {
    const r = await tiny.service<{ items?: Array<{ data: unknown }> }>('tiny.clipboard', { op: 'read', types: ['public.utf8-plain-text'] })
    const t = r?.items?.[0]?.data
    if (typeof t === 'string' && /^[\d.+\-*/^()\s]+$/.test(t.trim())) {
      if (result !== null) clearAll()
      expr += t.trim().replace(/\*/g, '×').replace(/\//g, '÷').replace(/-/g, '−')
      render()
    }
  } catch {
    /* nothing to paste */
  }
}

function setMode(next: boolean): void {
  sci = next
  $('calc').classList.toggle('sci', sci)
  $('m-basic').setAttribute('aria-pressed', String(!sci))
  $('m-sci').setAttribute('aria-pressed', String(sci))
  buildPad()
  void tiny.window.resize(260 + (sci ? 100 : 0), 400 + (sci ? 40 : 0)).catch(() => {})
}

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  const k = e.key
  if (/^[0-9.]$/.test(k) || '+-*/^%!()'.includes(k) && k.length === 1) press(normalizeKey(k))
  else if (sci && /^[a-z]$/i.test(k)) press(k.toLowerCase()) // function names are typed out
  else if (k === 'x' || k === 'X') press('×')
  else if (k === 'Enter' || k === '=') equals()
  else if (k === 'Backspace') backspace()
  else if (k === 'Escape' || k === 'c' || k === 'C') clearAll()
  else return
  e.preventDefault()
})

async function main(): Promise<void> {
  await tiny.ready
  $('m-basic').addEventListener('click', () => setMode(false))
  $('m-sci').addEventListener('click', () => setMode(true))
  $('angle').addEventListener('click', () => {
    angle = angle === 'deg' ? 'rad' : 'deg'
    $('angle').textContent = angle === 'deg' ? 'Deg' : 'Rad'
    render()
  })
  $('tape').addEventListener('click', () => toggleTape($('history').hidden))
  $('clearhist').addEventListener('click', () => ((history = []), renderHistory()))
  buildPad()
  renderHistory()
  void tiny.window.setMenus([
    { title: 'Calculator', items: [{ label: 'New Calculator', shortcut: 'Cmd+N', action: () => void tiny.app.openWindow() }] },
    {
      title: 'Edit',
      items: [
        { label: 'Copy Result', shortcut: 'Cmd+C', action: () => void copyResult() },
        { label: 'Paste', shortcut: 'Cmd+V', action: () => void pasteNumber() },
        { label: 'Clear', action: clearAll },
      ],
    },
    {
      title: 'View',
      items: [
        { label: 'Basic', shortcut: 'Cmd+1', checked: false, action: () => setMode(false) },
        { label: 'Scientific', shortcut: 'Cmd+2', checked: false, action: () => setMode(true) },
        { label: 'Show History', shortcut: 'Cmd+Y', action: () => toggleTape($('history').hidden) },
      ],
    },
  ])
  render()
  $('calc').focus()
}
void main()
