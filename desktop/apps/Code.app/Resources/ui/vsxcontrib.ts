// Applies an enabled extension's declarative contributions to Monaco: colour themes, snippets, and
// languages (file association + language configuration). Re-applied from scratch whenever the set of
// enabled extensions changes. TextMate grammars are not applied here (see the contract's status).
import * as monaco from 'monaco-editor/editor/editor.api.js'
import { parseJsonc } from './vsx'
import { readExtText, type Installed } from './vsxstore'

export interface ExtTheme { id: string; label: string; ext: string; dark: boolean }

const disposables: Array<{ dispose(): void }> = []
const themes = new Map<string, ExtTheme>()
const registeredLanguages = new Set<string>()
const extraLanguages: Array<{ id: string; exts: string[]; names: string[] }> = []

export const extensionThemes = (): ExtTheme[] => [...themes.values()]

/** Language id for a path from an extension's `contributes.languages`, if any claims it. */
export function extensionLanguageOf(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  for (const l of extraLanguages) if (l.names.includes(name) || l.exts.some((e) => name.endsWith(e))) return l.id
  return undefined
}

// TextMate scopes -> the token names Monaco's own (monarch) grammars emit
const SCOPE_TOKEN: Array<[RegExp, string]> = [
  [/^comment/, 'comment'],
  [/^string\.regexp/, 'regexp'],
  [/^string/, 'string'],
  [/^constant\.numeric/, 'number'],
  [/^constant/, 'constant'],
  [/^keyword\.operator/, 'operator'],
  [/^keyword|^storage/, 'keyword'],
  [/^entity\.name\.(function|method)|^support\.function/, 'function'],
  [/^entity\.name\.(type|class)|^support\.(type|class)/, 'type'],
  [/^entity\.name\.tag/, 'tag'],
  [/^entity\.other\.attribute-name/, 'attribute.name'],
  [/^variable/, 'variable'],
  [/^punctuation/, 'delimiter'],
]

const hexColor = (c: unknown): string | undefined => (typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c) ? c : undefined)
const bare = (c: string): string => c.replace('#', '')

interface ThemeFile {
  include?: string
  type?: string
  colors?: Record<string, string>
  tokenColors?: Array<{ scope?: string | string[]; settings?: { foreground?: string; fontStyle?: string } }>
}

async function loadTheme(ext: Installed, rel: string, depth = 0): Promise<ThemeFile> {
  const file = parseJsonc<ThemeFile>(await readExtText(ext, rel))
  if (!file.include || depth > 3) return file
  const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/') + 1) : ''
  const base = await loadTheme(ext, dir + file.include.replace(/^\.\//, ''), depth + 1)
  return { ...base, ...file, colors: { ...base.colors, ...file.colors }, tokenColors: [...(base.tokenColors ?? []), ...(file.tokenColors ?? [])] }
}

export function toMonacoTheme(file: ThemeFile, uiTheme?: string): monaco.editor.IStandaloneThemeData {
  const kind = file.type ?? (uiTheme === 'vs' ? 'light' : uiTheme === 'hc-black' ? 'hc' : 'dark')
  const rules: monaco.editor.ITokenThemeRule[] = []
  for (const tc of file.tokenColors ?? []) {
    const fg = hexColor(tc.settings?.foreground)
    const style = tc.settings?.fontStyle
    if (!fg && style === undefined) continue
    const scopes = (Array.isArray(tc.scope) ? tc.scope : (tc.scope ?? '').split(',')).map((s) => s.trim()).filter(Boolean)
    for (const scope of scopes.length ? scopes : ['']) {
      const token = scope === '' ? '' : (SCOPE_TOKEN.find(([re]) => re.test(scope))?.[1] ?? scope)
      rules.push({ token, ...(fg ? { foreground: bare(fg) } : {}), ...(style !== undefined ? { fontStyle: style } : {}) })
    }
  }
  const colors: Record<string, string> = {}
  for (const [k, v] of Object.entries(file.colors ?? {})) if (hexColor(v)) colors[k] = v
  return { base: kind === 'light' ? 'vs' : kind === 'hc' ? 'hc-black' : 'vs-dark', inherit: true, rules, colors }
}

interface SnippetFile { [name: string]: { prefix?: string | string[]; body?: string | string[]; description?: string } }

function applySnippets(file: SnippetFile, language: string | undefined): void {
  const items = Object.entries(file).flatMap(([name, s]) => {
    const body = Array.isArray(s.body) ? s.body.join('\n') : s.body
    const prefixes = Array.isArray(s.prefix) ? s.prefix : s.prefix ? [s.prefix] : []
    return body === undefined ? [] : prefixes.map((prefix) => ({ name, prefix, body, description: s.description }))
  })
  if (!items.length) return
  const provider: monaco.languages.CompletionItemProvider = {
    provideCompletionItems(model, position) {
      const word = model.getWordUntilPosition(position)
      const range = { startLineNumber: position.lineNumber, endLineNumber: position.lineNumber, startColumn: word.startColumn, endColumn: word.endColumn }
      return {
        suggestions: items.map((i) => ({
          label: i.prefix,
          detail: i.name,
          documentation: i.description,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: i.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          range,
        })),
      }
    },
  }
  disposables.push(monaco.languages.registerCompletionItemProvider(language ?? '*', provider))
}

interface LangConfigFile {
  comments?: { lineComment?: string; blockComment?: [string, string] }
  brackets?: Array<[string, string]>
  autoClosingPairs?: Array<[string, string] | { open: string; close: string; notIn?: string[] }>
  surroundingPairs?: Array<[string, string] | { open: string; close: string }>
  wordPattern?: string
}

const pair = <T extends { open: string; close: string }>(p: [string, string] | T): T | { open: string; close: string } => (Array.isArray(p) ? { open: p[0], close: p[1] } : p)

function toLanguageConfiguration(c: LangConfigFile): monaco.languages.LanguageConfiguration {
  let wordPattern: RegExp | undefined
  if (c.wordPattern) {
    try {
      wordPattern = new RegExp(c.wordPattern)
    } catch {
      /* an invalid pattern keeps Monaco's default */
    }
  }
  return {
    ...(c.comments ? { comments: c.comments } : {}),
    ...(c.brackets ? { brackets: c.brackets } : {}),
    ...(c.autoClosingPairs ? { autoClosingPairs: c.autoClosingPairs.map(pair) as monaco.languages.IAutoClosingPairConditional[] } : {}),
    ...(c.surroundingPairs ? { surroundingPairs: c.surroundingPairs.map(pair) as monaco.languages.IAutoClosingPair[] } : {}),
    ...(wordPattern ? { wordPattern } : {}),
  }
}

export interface ApplyResult { errors: Array<{ id: string; message: string }> }

/** Drop everything previously applied and apply the enabled extensions' contributions. */
export async function applyAll(list: Installed[]): Promise<ApplyResult> {
  for (const d of disposables.splice(0)) d.dispose()
  themes.clear()
  extraLanguages.length = 0
  const errors: ApplyResult['errors'] = []
  for (const ext of list.filter((e) => e.enabled)) {
    const c = ext.manifest.contributes ?? {}
    const guard = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn()
      } catch (e) {
        errors.push({ id: ext.id, message: `${what}: ${(e as Error).message}` })
      }
    }
    for (const t of c.themes ?? []) {
      await guard(`theme ${t.label}`, async () => {
        const id = `vsx:${ext.id}:${t.label}`
        const data = await loadTheme(ext, t.path)
        monaco.editor.defineTheme(id, toMonacoTheme(data, t.uiTheme))
        themes.set(id, { id, label: t.label, ext: ext.id, dark: t.uiTheme !== 'vs' && data.type !== 'light' })
      })
    }
    for (const s of c.snippets ?? []) {
      await guard(`snippets ${s.path}`, async () => applySnippets(parseJsonc<SnippetFile>(await readExtText(ext, s.path)), s.language))
    }
    for (const l of c.languages ?? []) {
      await guard(`language ${l.id}`, async () => {
        if (!registeredLanguages.has(l.id)) {
          monaco.languages.register({ id: l.id, extensions: l.extensions, filenames: l.filenames, aliases: l.aliases })
          registeredLanguages.add(l.id) // Monaco cannot unregister: it stays until the window reloads
        }
        extraLanguages.push({ id: l.id, exts: (l.extensions ?? []).map((e) => e.toLowerCase()), names: (l.filenames ?? []).map((n) => n.toLowerCase()) })
        if (l.configuration) disposables.push(monaco.languages.setLanguageConfiguration(l.id, toLanguageConfiguration(parseJsonc<LangConfigFile>(await readExtText(ext, l.configuration)))))
      })
    }
  }
  return { errors }
}

/** Select an extension colour theme. Returns false when it is not (or no longer) available. */
export function setExtensionTheme(id: string): boolean {
  if (!themes.has(id)) return false
  monaco.editor.setTheme(id)
  return true
}
