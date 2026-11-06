// Keybindings, VS Code style: key strings like `ctrlcmd+shift+p` and chords (`ctrlcmd+k ctrlcmd+s`),
// a default keymap, user overrides from keybindings.json, bindings contributed by extensions, and
// `when` clauses. `ctrlcmd` is Cmd on a Mac and Ctrl elsewhere, as in VS Code. Editor shortcuts
// (find, multi-cursor, fold, move line...) are Monaco's own, which are VS Code's; this layer is
// the workbench: palette, quick open, side bar, tabs, explorer, and so on.

export interface Binding {
  key: string
  command: string
  when?: string
  args?: unknown
  source: 'default' | 'user' | 'extension'
}

export interface RawBinding {
  key: string
  mac?: string
  win?: string
  linux?: string
  command: string
  when?: string
  args?: unknown
}

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'cmd']
const ALIAS: Record<string, string> = { meta: 'cmd', command: 'cmd', win: 'cmd', super: 'cmd', option: 'alt', control: 'ctrl', esc: 'escape', return: 'enter', del: 'delete', arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down', ' ': 'space', spacebar: 'space' }
const CODE_KEY: Record<string, string> = { BracketLeft: '[', BracketRight: ']', Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Semicolon: ';', Quote: "'", Space: 'space', Enter: 'enter', Escape: 'escape', Tab: 'tab', Backspace: 'backspace', Delete: 'delete', ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pageup', PageDown: 'pagedown', Home: 'home', End: 'end' }

export const isMac = (platform: string): boolean => /mac|iphone|ipad/i.test(platform)

/** One chord from an event, in canonical form (`ctrl+alt+shift+cmd+key`). */
export function chordOf(e: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): string | null {
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return null
  let key: string
  if (CODE_KEY[e.code]) key = CODE_KEY[e.code]!
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3).toLowerCase()
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6)
  else if (/^F\d+$/.test(e.code)) key = e.code.toLowerCase()
  else key = (ALIAS[e.key.toLowerCase()] ?? e.key.toLowerCase())
  const mods = [e.ctrlKey && 'ctrl', e.altKey && 'alt', e.shiftKey && 'shift', e.metaKey && 'cmd'].filter(Boolean) as string[]
  return [...mods, key].join('+')
}

/** A key string to canonical chords, or null when it cannot be understood. */
export function parseKey(spec: string, mac: boolean): string[] | null {
  const chords: string[] = []
  for (const part of spec.trim().toLowerCase().split(/\s+/).filter(Boolean)) {
    // a trailing "+" is the plus key ("ctrl++")
    const plus = part.endsWith('+')
    const bits = plus ? (part.slice(0, -2) ? part.slice(0, -2).split('+') : []) : part.split('+')
    const raw = plus ? '+' : bits.pop() ?? ''
    const key = ALIAS[raw] ?? raw
    const mods = new Set<string>()
    for (const m of bits) {
      const name = m === 'ctrlcmd' ? (mac ? 'cmd' : 'ctrl') : (ALIAS[m] ?? m)
      if (!MOD_ORDER.includes(name)) return null
      mods.add(name)
    }
    if (!key) return null
    chords.push([...MOD_ORDER.filter((m) => mods.has(m)), key].join('+'))
  }
  return chords.length ? chords : null
}

const GLYPH: Record<string, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', cmd: '⌘', enter: '↩', escape: 'Esc', backspace: '⌫', delete: '⌦', left: '←', right: '→', up: '↑', down: '↓', tab: '⇥', space: 'Space', pageup: 'PgUp', pagedown: 'PgDn' }
const WORD: Record<string, string> = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', cmd: 'Win', escape: 'Esc', enter: 'Enter', backspace: 'Backspace', delete: 'Delete', left: 'Left', right: 'Right', up: 'Up', down: 'Down', tab: 'Tab', space: 'Space', pageup: 'PageUp', pagedown: 'PageDown' }

/** `⇧⌘P` on a Mac, `Ctrl+Shift+P` elsewhere; chords are separated by a space. */
export function display(chords: string[], mac: boolean): string {
  return chords
    .map((c) => {
      const parts = c.split('+')
      const key = parts.pop()!
      const k = (mac ? GLYPH[key] : WORD[key]) ?? key.toUpperCase()
      const mods = parts.map((m) => (mac ? GLYPH[m] : WORD[m]) ?? m)
      return mac ? mods.join('') + k : [...mods, k].join('+')
    })
    .join(' ')
}

// ---- `when` clauses: names, !, &&, ||, ==, !=, parentheses
export type Context = Record<string, boolean | string | undefined>

export function evalWhen(expr: string | undefined, ctx: Context): boolean {
  if (!expr?.trim()) return true
  const tokens = expr.match(/&&|\|\||==|!=|[!()]|'[^']*'|"[^"]*"|[\w.\-:]+/g) ?? []
  let i = 0
  const value = (t: string): boolean | string | undefined => (/^['"]/.test(t) ? t.slice(1, -1) : ctx[t] ?? (t === 'true' ? true : t === 'false' ? false : undefined))
  const primary = (): boolean => {
    const t = tokens[i++]
    if (t === '!') return !primary()
    if (t === '(') {
      const v = or()
      i++ // )
      return v
    }
    if (t === undefined) return false
    const next = tokens[i]
    if (next === '==' || next === '!=') {
      i++
      const rhs = value(tokens[i++] ?? '')
      const eq = String(value(t) ?? '') === String(rhs ?? '')
      return next === '==' ? eq : !eq
    }
    const v = value(t)
    return typeof v === 'string' ? v !== '' : !!v
  }
  const and = (): boolean => {
    let v = primary()
    while (tokens[i] === '&&') (i++, (v = primary() && v))
    return v
  }
  const or = (): boolean => {
    let v = and()
    while (tokens[i] === '||') (i++, (v = and() || v))
    return v
  }
  return or()
}

export interface Keymap {
  set(source: Binding['source'], raw: RawBinding[]): void
  /** The effective bindings: user entries replace defaults, and `-command` entries remove them. */
  all(): Array<Binding & { chords: string[] }>
  /** Feed a key event. `run` when it completes a binding, `pending` after the first key of a chord, null when it is not ours. */
  handle(e: KeyboardEvent, ctx: Context): { run: Binding } | 'pending' | null
  /** How a command's first key reads, for menus and the palette. */
  hint(command: string): string
  cancel(): void
}

export function createKeymap(mac: boolean, onPending: (shown: string | null) => void): Keymap {
  const sources: Record<Binding['source'], Array<Binding & { chords: string[] }>> = { default: [], user: [], extension: [] }
  const removed = new Set<string>()
  let pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const pick = (r: RawBinding): string => (mac ? r.mac : /win/i.test(navigator.platform) ? r.win : r.linux) ?? r.key

  const reset = (): void => {
    pending = []
    clearTimeout(timer)
    onPending(null)
  }

  const effective = (): Array<Binding & { chords: string[] }> => {
    const out = [...sources.default, ...sources.extension].filter((b) => !removed.has(`${b.command}\u0000${b.chords.join(' ')}`))
    // a user binding takes over: later entries win, so they are listed last
    return [...out, ...sources.user]
  }

  return {
    set(source, raw) {
      if (source === 'user') {
        removed.clear()
        for (const r of raw) {
          const chords = r.command.startsWith('-') ? parseKey(pick(r), mac) : null
          if (chords) removed.add(`${r.command.slice(1)}\u0000${chords.join(' ')}`)
        }
      }
      sources[source] = raw.flatMap((r) => {
        const chords = r.command.startsWith('-') ? null : parseKey(pick(r), mac)
        return chords ? [{ key: pick(r), command: r.command, when: r.when, args: r.args, source, chords }] : []
      })
    },
    all: effective,
    handle(e, ctx) {
      const chord = chordOf(e)
      if (!chord) return null
      const typed = [...pending, chord]
      const candidates = effective().filter((b) => b.chords.length >= typed.length && typed.every((c, i) => b.chords[i] === c) && evalWhen(b.when, ctx))
      if (!candidates.length) {
        const wasPending = pending.length > 0
        reset()
        return wasPending ? 'pending' : null // a dead chord swallows its second key, like VS Code
      }
      // the last matching entry wins (user > extension > default)
      const exact = [...candidates].reverse().find((b) => b.chords.length === typed.length)
      if (exact && !candidates.some((b) => b.chords.length > typed.length)) {
        reset()
        return { run: exact }
      }
      pending = typed
      clearTimeout(timer)
      timer = setTimeout(reset, 3000)
      onPending(`(${display(typed, mac)}) was pressed. Waiting for second key of chord…`)
      return 'pending'
    },
    hint(command) {
      const b = [...effective()].reverse().find((x) => x.command === command)
      return b ? display(b.chords, mac) : ''
    },
    cancel: reset,
  }
}

/** The default workbench keymap (VS Code's). `ctrlcmd` is Cmd on a Mac, Ctrl elsewhere. */
export const DEFAULT_KEYS: RawBinding[] = [
  { key: 'ctrlcmd+shift+p', command: 'workbench.action.showCommands' },
  { key: 'f1', command: 'workbench.action.showCommands' },
  { key: 'ctrlcmd+p', command: 'workbench.action.quickOpen' },
  { key: 'ctrlcmd+b', command: 'workbench.action.toggleSidebarVisibility' },
  { key: 'ctrlcmd+j', command: 'workbench.action.togglePanel' },
  { key: 'ctrlcmd+shift+e', command: 'workbench.view.explorer' },
  { key: 'ctrlcmd+shift+x', command: 'workbench.view.extensions' },
  { key: 'ctrlcmd+shift+u', command: 'workbench.action.output.toggleOutput' },
  { key: 'ctrlcmd+shift+m', command: 'workbench.actions.view.problems' },
  { key: 'ctrlcmd+shift+y', command: 'workbench.debug.action.toggleRepl' },
  { key: 'ctrl+`', command: 'workbench.action.terminal.toggleTerminal' },
  { key: 'ctrl+shift+`', command: 'workbench.action.terminal.new' },
  { key: 'ctrlcmd+k ctrlcmd+s', command: 'workbench.action.openGlobalKeybindings' },
  { key: 'ctrlcmd+k ctrlcmd+t', command: 'workbench.action.selectTheme' },
  { key: 'ctrlcmd+k v', command: 'markdown.showPreviewToSide' },
  { key: 'ctrlcmd+shift+v', command: 'markdown.showPreviewToSide' },
  { key: 'ctrlcmd+n', command: 'workbench.action.files.newUntitledFile' },
  { key: 'ctrlcmd+o', command: 'workbench.action.files.openFolder' },
  { key: 'ctrlcmd+s', command: 'workbench.action.files.save' },
  { key: 'ctrlcmd+alt+s', command: 'workbench.action.files.saveAll' },
  { key: 'ctrlcmd+w', command: 'workbench.action.closeActiveEditor' },
  { key: 'ctrlcmd+shift+w', command: 'workbench.action.closeWindow' },
  { key: 'ctrlcmd+k ctrlcmd+w', command: 'workbench.action.closeAllEditors' },
  { key: 'ctrlcmd+k w', command: 'workbench.action.closeAllEditors' },
  { key: 'ctrlcmd+alt+t', command: 'workbench.action.closeOtherEditors' },
  { key: 'ctrlcmd+shift+t', command: 'workbench.action.reopenClosedEditor' },
  { key: 'ctrlcmd+alt+right', command: 'workbench.action.nextEditor' },
  { key: 'ctrlcmd+alt+left', command: 'workbench.action.previousEditor' },
  { key: 'ctrlcmd+shift+]', command: 'workbench.action.nextEditor' },
  { key: 'ctrlcmd+shift+[', command: 'workbench.action.previousEditor' },
  { key: 'ctrl+tab', command: 'workbench.action.nextEditor' },
  { key: 'ctrl+shift+tab', command: 'workbench.action.previousEditor' },
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n): RawBinding => ({ key: `alt+${n}`, mac: `ctrl+${n}`, command: `workbench.action.openEditorAtIndex${n}` })),
  { key: 'ctrlcmd+shift+b', command: 'workbench.action.tasks.build' },
  { key: 'ctrl+g', command: 'workbench.action.gotoLine' },
  { key: 'ctrlcmd+shift+o', command: 'workbench.action.gotoSymbol' },
  { key: 'alt+z', command: 'editor.action.toggleWordWrap' },
  { key: 'f2', command: 'renameFile', when: 'explorerViewletFocus && !inputFocus' },
  { key: 'delete', mac: 'cmd+backspace', command: 'deleteFile', when: 'explorerViewletFocus && !inputFocus' },
  { key: 'f5', command: 'workbench.action.reloadPreview', when: 'hasProject' },
  { key: 'ctrlcmd+r', command: 'workbench.action.reloadPreview', when: 'hasProject' },
]
