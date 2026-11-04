// The quick pick overlay: Command Palette (Cmd+Shift+P), Quick Open (Cmd+P, with `>` for commands,
// `:` for a line number and `@` for symbols), and the Keyboard Shortcuts list.
import { escapeHtml } from '@tiny/sdk'

export interface PickItem {
  label: string
  description?: string
  /** The key hint on the right, like ⇧⌘P. */
  keys?: string
  run(): void
}

export interface PaletteSource {
  commands(): PickItem[]
  files(): PickItem[]
  shortcuts(): PickItem[]
  gotoLine(line: number): void
  gotoSymbol(): void
}

let overlay: HTMLElement | null = null

/** A fuzzy score: subsequence match, preferring consecutive and word-start hits. Null when it does not match. */
export function score(query: string, text: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let ti = 0
  let total = 0
  let run = 0
  for (const ch of q) {
    const at = t.indexOf(ch, ti)
    if (at < 0) return null
    run = at === ti ? run + 1 : 0
    total += 1 + run * 2 + (at === 0 || /[\s/._-]/.test(t[at - 1] ?? '') ? 3 : 0) - Math.min(at - ti, 5) * 0.2
    ti = at + 1
  }
  return total - t.length * 0.01
}

export const isOpen = (): boolean => !!overlay

export function close(): void {
  overlay?.remove()
  overlay = null
}

export type Mode = 'commands' | 'files' | 'keys'

export function open(source: PaletteSource, mode: Mode, restoreFocus: () => void): void {
  close()
  const el = document.createElement('div')
  el.className = 'palette-backdrop'
  el.innerHTML = `<div class="palette" role="dialog" aria-label="Quick pick"><input class="palette-input" type="text" spellcheck="false" autocomplete="off" aria-label="Type to filter"><div class="palette-list" role="listbox"></div></div>`
  const input = el.querySelector<HTMLInputElement>('input')!
  const list = el.querySelector<HTMLElement>('.palette-list')!
  let items: PickItem[] = []
  let chosen = 0

  const base = (): { prefix: string; pool: PickItem[]; placeholder: string } => {
    const v = input.value
    if (mode === 'keys') return { prefix: '', pool: source.shortcuts(), placeholder: 'Type to search keyboard shortcuts' }
    if (mode === 'commands' || v.startsWith('>')) return { prefix: mode === 'commands' ? '' : '>', pool: source.commands(), placeholder: 'Type the name of a command to run' }
    return { prefix: '', pool: source.files(), placeholder: 'Search files by name (append : to go to a line, > for commands, @ for symbols)' }
  }

  const draw = (): void => {
    const v = input.value
    const { prefix, pool, placeholder } = base()
    input.placeholder = placeholder
    if (mode === 'files' && v.startsWith(':')) {
      const line = parseInt(v.slice(1), 10)
      items = Number.isFinite(line) && line > 0 ? [{ label: `Go to line ${line}`, run: () => source.gotoLine(line) }] : [{ label: 'Type a line number to go to', run: () => {} }]
    } else if (mode === 'files' && v.startsWith('@')) {
      items = [{ label: 'Go to Symbol in Editor…', run: () => source.gotoSymbol() }]
    } else {
      const q = prefix ? v.slice(prefix.length).trim() : v.trim()
      items = pool
        .map((it) => ({ it, s: score(q, it.label + (it.description ? ` ${it.description}` : '')) }))
        .filter((x): x is { it: PickItem; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s)
        .slice(0, 200)
        .map((x) => x.it)
    }
    chosen = Math.min(chosen, Math.max(0, items.length - 1))
    list.replaceChildren(
      ...(items.length
        ? items.map((it, i) => {
            const row = document.createElement('div')
            row.className = 'palette-row'
            row.setAttribute('role', 'option')
            row.setAttribute('aria-selected', String(i === chosen))
            row.innerHTML = `<span class="pl">${escapeHtml(it.label)}</span>${it.description ? `<span class="pd">${escapeHtml(it.description)}</span>` : ''}<span class="grow"></span>${it.keys ? `<kbd class="pk">${escapeHtml(it.keys)}</kbd>` : ''}`
            row.addEventListener('mousemove', () => {
              if (chosen === i) return
              list.children[chosen]?.setAttribute('aria-selected', 'false')
              chosen = i
              row.setAttribute('aria-selected', 'true')
            })
            row.addEventListener('click', () => accept(i))
            return row
          })
        : [Object.assign(document.createElement('div'), { className: 'palette-empty', textContent: 'No matching results' })]),
    )
    list.children[chosen]?.scrollIntoView({ block: 'nearest' })
  }

  const accept = (i: number): void => {
    const it = items[i]
    if (!it) return
    close()
    restoreFocus()
    it.run()
  }

  input.addEventListener('input', () => {
    chosen = 0
    draw()
  })
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
      restoreFocus()
    } else if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) {
      e.preventDefault()
      chosen = (chosen + 1) % Math.max(1, items.length)
      draw()
    } else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p')) {
      e.preventDefault()
      chosen = (chosen - 1 + items.length) % Math.max(1, items.length)
      draw()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      accept(chosen)
    }
  })
  el.addEventListener('mousedown', (e) => {
    if (e.target === el) {
      close()
      restoreFocus()
    }
  })
  document.body.append(el)
  overlay = el
  if (mode === 'commands') input.value = ''
  draw()
  input.focus()
}
