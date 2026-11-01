// IntelliSense for AssemblyScript. The language reads like TypeScript but has its own standard
// library (i32, f64, @inline, load/store...), so the ordinary TypeScript service, with the DOM and
// ES libs, would call valid code wrong. This runs a second TypeScript worker with no default libs
// and AssemblyScript's own `std/assembly/index.d.ts`, syncs only the AssemblyScript files into it,
// and connects it to the editor: diagnostics, completion, hover, signature help, go to definition.
import * as monaco from 'monaco-editor/editor/editor.api.js'

export const AS_LANGUAGE = 'assemblyscript'
const OWNER = 'assemblyscript'
const LIB_URI = 'file:///node_modules/assemblyscript/std/assembly/index.d.ts'
/** Decorators (@inline, @global, @unsafe...) on functions are AssemblyScript syntax, not an error. */
const IGNORED_CODES = new Set([1206, 1207, 1219])

interface TsDiagnostic {
  start?: number
  length?: number
  code: number
  category: number
  messageText: string | { messageText: string; next?: unknown[] }
}
interface DisplayPart {
  text: string
}
interface TsWorker {
  getSyntacticDiagnostics(file: string): Promise<TsDiagnostic[]>
  getSemanticDiagnostics(file: string): Promise<TsDiagnostic[]>
  getCompletionsAtPosition(file: string, pos: number): Promise<{ entries: Array<{ name: string; kind: string; sortText: string; insertText?: string; replacementSpan?: { start: number; length: number } }> } | undefined>
  getCompletionEntryDetails(file: string, pos: number, name: string): Promise<{ displayParts?: DisplayPart[]; documentation?: DisplayPart[] } | undefined>
  getQuickInfoAtPosition(file: string, pos: number): Promise<{ displayParts?: DisplayPart[]; documentation?: DisplayPart[]; textSpan: { start: number; length: number } } | undefined>
  getSignatureHelpItems(file: string, pos: number, options: object): Promise<
    | {
        selectedItemIndex: number
        argumentIndex: number
        items: Array<{ prefixDisplayParts: DisplayPart[]; suffixDisplayParts: DisplayPart[]; separatorDisplayParts: DisplayPart[]; documentation: DisplayPart[]; parameters: Array<{ displayParts: DisplayPart[]; documentation: DisplayPart[] }> }>
      }
    | undefined
  >
  getDefinitionAtPosition(file: string, pos: number): Promise<Array<{ fileName: string; textSpan: { start: number; length: number } }> | undefined>
}

const text = (parts?: DisplayPart[]): string => (parts ?? []).map((p) => p.text).join('')
const flatten = (m: TsDiagnostic['messageText']): string => (typeof m === 'string' ? m : [m.messageText, ...((m.next as Array<typeof m> | undefined) ?? []).map(flatten)].join('\n'))

const K = monaco.languages.CompletionItemKind
const KINDS: Record<string, monaco.languages.CompletionItemKind> = {
  function: K.Function, 'local function': K.Function, method: K.Method, constructor: K.Constructor, class: K.Class, interface: K.Interface,
  enum: K.Enum, 'enum member': K.EnumMember, var: K.Variable, let: K.Variable, const: K.Constant, 'local var': K.Variable, parameter: K.Variable,
  property: K.Property, getter: K.Property, setter: K.Property, keyword: K.Keyword, module: K.Module, type: K.TypeParameter, alias: K.Reference, 'primitive type': K.Keyword, string: K.Value,
}

let client: Promise<monaco.editor.MonacoWebWorker<TsWorker>> | null = null
let readSource: (() => Promise<{ worker: string; std: string }>) | null = null

const asModels = (): monaco.editor.ITextModel[] => monaco.editor.getModels().filter((m) => m.getLanguageId() === AS_LANGUAGE)

async function proxy(): Promise<TsWorker> {
  if (!client) {
    client = (async () => {
      const { worker, std } = await readSource!()
      const w = new Worker(worker)
      w.postMessage('ignore')
      w.postMessage({
        compilerOptions: { target: 99, module: 99, moduleResolution: 2, noLib: true, allowNonTsExtensions: true, noEmit: true, experimentalDecorators: true, strict: false, skipLibCheck: true },
        extraLibs: { [LIB_URI]: { content: std, version: 1 } },
        inlayHintsOptions: {},
      })
      return monaco.editor.createWebWorker<TsWorker>({ worker: w, keepIdleModels: true })
    })()
  }
  const c = await client
  await c.withSyncedResources(asModels().map((m) => m.uri))
  return c.getProxy()
}

// ---- diagnostics
const timers = new Map<string, ReturnType<typeof setTimeout>>()

async function validate(model: monaco.editor.ITextModel): Promise<void> {
  if (model.isDisposed()) return
  const version = model.getVersionId()
  const ts = await proxy()
  const file = model.uri.toString()
  const [syntax, semantic] = await Promise.all([ts.getSyntacticDiagnostics(file), ts.getSemanticDiagnostics(file)])
  if (model.isDisposed() || model.getVersionId() !== version) return
  const markers: monaco.editor.IMarkerData[] = [...syntax, ...semantic]
    .filter((d) => !IGNORED_CODES.has(d.code) && d.start !== undefined)
    .map((d) => {
      const a = model.getPositionAt(d.start!)
      const b = model.getPositionAt(d.start! + (d.length ?? 0))
      return {
        severity: d.category === 1 ? monaco.MarkerSeverity.Error : d.category === 0 ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Info,
        message: flatten(d.messageText),
        startLineNumber: a.lineNumber,
        startColumn: a.column,
        endLineNumber: b.lineNumber,
        endColumn: b.column,
        code: String(d.code),
        source: 'AssemblyScript',
      }
    })
  monaco.editor.setModelMarkers(model, OWNER, markers)
}

/** Check every AssemblyScript file soon: an edit in one can change what another reports. */
function scheduleAll(): void {
  for (const m of asModels()) {
    const key = m.uri.toString()
    clearTimeout(timers.get(key))
    timers.set(key, setTimeout(() => void validate(m).catch(() => {}), 400))
  }
}

function watch(model: monaco.editor.ITextModel): void {
  if (model.getLanguageId() !== AS_LANGUAGE) return
  model.onDidChangeContent(scheduleAll)
  model.onWillDispose(() => monaco.editor.setModelMarkers(model, OWNER, []))
  scheduleAll()
}

/**
 * Turn the service on. `read` loads what it needs from the app bundle: the worker script's blob URL
 * and the text of AssemblyScript's standard library declarations.
 */
export function setupAssemblyScript(read: () => Promise<{ worker: string; std: string }>): void {
  readSource = read
  monaco.editor.onDidCreateModel(watch)
  monaco.editor.getModels().forEach(watch)

  const L = monaco.languages
  const offset = (m: monaco.editor.ITextModel, p: monaco.IPosition): number => m.getOffsetAt(p)
  const rangeOf = (m: monaco.editor.ITextModel, span: { start: number; length: number }): monaco.Range => {
    const a = m.getPositionAt(span.start)
    const b = m.getPositionAt(span.start + span.length)
    return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column)
  }

  L.registerCompletionItemProvider(AS_LANGUAGE, {
    triggerCharacters: ['.', '"', "'", '/', '@', '<'],
    async provideCompletionItems(model, position) {
      const ts = await proxy()
      const pos = offset(model, position)
      const info = await ts.getCompletionsAtPosition(model.uri.toString(), pos)
      if (!info) return { suggestions: [] }
      const word = model.getWordUntilPosition(position)
      const fallback = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn)
      return {
        suggestions: info.entries.map((e) => ({
          label: e.name,
          kind: KINDS[e.kind] ?? K.Property,
          insertText: e.insertText ?? e.name,
          sortText: e.sortText,
          range: e.replacementSpan ? rangeOf(model, e.replacementSpan) : fallback,
          // carried to resolveCompletionItem
          uri: model.uri,
          offset: pos,
        })) as monaco.languages.CompletionItem[],
      }
    },
    async resolveCompletionItem(item) {
      const extra = item as unknown as { uri: monaco.Uri; offset: number }
      const ts = await proxy()
      const details = await ts.getCompletionEntryDetails(extra.uri.toString(), extra.offset, typeof item.label === 'string' ? item.label : item.label.label)
      if (details) {
        item.detail = text(details.displayParts)
        item.documentation = { value: text(details.documentation) }
      }
      return item
    },
  })

  L.registerHoverProvider(AS_LANGUAGE, {
    async provideHover(model, position) {
      const ts = await proxy()
      const info = await ts.getQuickInfoAtPosition(model.uri.toString(), offset(model, position))
      if (!info) return null
      const contents: monaco.IMarkdownString[] = [{ value: '```typescript\n' + text(info.displayParts) + '\n```' }]
      const doc = text(info.documentation)
      if (doc) contents.push({ value: doc })
      return { range: rangeOf(model, info.textSpan), contents }
    },
  })

  L.registerSignatureHelpProvider(AS_LANGUAGE, {
    signatureHelpTriggerCharacters: ['(', ','],
    signatureHelpRetriggerCharacters: [')'],
    async provideSignatureHelp(model, position) {
      const ts = await proxy()
      const help = await ts.getSignatureHelpItems(model.uri.toString(), offset(model, position), {})
      if (!help) return null
      return {
        value: {
          activeSignature: help.selectedItemIndex,
          activeParameter: help.argumentIndex,
          signatures: help.items.map((item) => {
            const sep = text(item.separatorDisplayParts)
            const params = item.parameters.map((p) => ({ label: text(p.displayParts), documentation: { value: text(p.documentation) } }))
            return {
              label: text(item.prefixDisplayParts) + params.map((p) => p.label).join(sep) + text(item.suffixDisplayParts),
              documentation: { value: text(item.documentation) },
              parameters: params,
            }
          }),
        },
        dispose: () => {},
      }
    },
  })

  L.registerDefinitionProvider(AS_LANGUAGE, {
    async provideDefinition(model, position) {
      const ts = await proxy()
      const defs = await ts.getDefinitionAtPosition(model.uri.toString(), offset(model, position))
      const out: monaco.languages.Location[] = []
      for (const d of defs ?? []) {
        const target = monaco.editor.getModel(monaco.Uri.parse(d.fileName))
        if (target) out.push({ uri: target.uri, range: rangeOf(target, d.textSpan) })
      }
      return out
    },
  })
}
