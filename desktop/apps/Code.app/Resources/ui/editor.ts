// The editor layer: Monaco, themed with Pear's CSS variables. Language grammars are Monaco's
// monarch definitions (no language workers — they are blocked in app windows); editing, find and
// multi-cursor all work, semantic services (IntelliSense, diagnostics) do not, by design.
(window as unknown as Record<string, unknown>).__monaco = true
import 'monaco-editor/languages/definitions/abap/register.js'
import 'monaco-editor/languages/definitions/apex/register.js'
import 'monaco-editor/languages/definitions/azcli/register.js'
import 'monaco-editor/languages/definitions/bat/register.js'
import 'monaco-editor/languages/definitions/bicep/register.js'
import 'monaco-editor/languages/definitions/cameligo/register.js'
import 'monaco-editor/languages/definitions/clojure/register.js'
import 'monaco-editor/languages/definitions/coffee/register.js'
import 'monaco-editor/languages/definitions/cpp/register.js'
import 'monaco-editor/languages/definitions/csharp/register.js'
import 'monaco-editor/languages/definitions/csp/register.js'
import 'monaco-editor/languages/definitions/css/register.js'
import 'monaco-editor/languages/definitions/cypher/register.js'
import 'monaco-editor/languages/definitions/dart/register.js'
import 'monaco-editor/languages/definitions/dockerfile/register.js'
import 'monaco-editor/languages/definitions/ecl/register.js'
import 'monaco-editor/languages/definitions/elixir/register.js'
import 'monaco-editor/languages/definitions/flow9/register.js'
import 'monaco-editor/languages/definitions/fsharp/register.js'
import 'monaco-editor/languages/definitions/freemarker2/register.js'
import 'monaco-editor/languages/definitions/go/register.js'
import 'monaco-editor/languages/definitions/graphql/register.js'
import 'monaco-editor/languages/definitions/handlebars/register.js'
import 'monaco-editor/languages/definitions/hcl/register.js'
import 'monaco-editor/languages/definitions/html/register.js'
import 'monaco-editor/languages/definitions/ini/register.js'
import 'monaco-editor/languages/definitions/java/register.js'
import 'monaco-editor/languages/definitions/javascript/register.js'
import 'monaco-editor/languages/definitions/julia/register.js'
import 'monaco-editor/languages/definitions/kotlin/register.js'
import 'monaco-editor/languages/definitions/less/register.js'
import 'monaco-editor/languages/definitions/lexon/register.js'
import 'monaco-editor/languages/definitions/lua/register.js'
import 'monaco-editor/languages/definitions/liquid/register.js'
import 'monaco-editor/languages/definitions/m3/register.js'
import 'monaco-editor/languages/definitions/markdown/register.js'
import 'monaco-editor/languages/definitions/mdx/register.js'
import 'monaco-editor/languages/definitions/mips/register.js'
import 'monaco-editor/languages/definitions/msdax/register.js'
import 'monaco-editor/languages/definitions/mysql/register.js'
import 'monaco-editor/languages/definitions/objective-c/register.js'
import 'monaco-editor/languages/definitions/pascal/register.js'
import 'monaco-editor/languages/definitions/pascaligo/register.js'
import 'monaco-editor/languages/definitions/perl/register.js'
import 'monaco-editor/languages/definitions/pgsql/register.js'
import 'monaco-editor/languages/definitions/php/register.js'
import 'monaco-editor/languages/definitions/pla/register.js'
import 'monaco-editor/languages/definitions/postiats/register.js'
import 'monaco-editor/languages/definitions/powerquery/register.js'
import 'monaco-editor/languages/definitions/powershell/register.js'
import 'monaco-editor/languages/definitions/protobuf/register.js'
import 'monaco-editor/languages/definitions/pug/register.js'
import 'monaco-editor/languages/definitions/python/register.js'
import 'monaco-editor/languages/definitions/qsharp/register.js'
import 'monaco-editor/languages/definitions/r/register.js'
import 'monaco-editor/languages/definitions/razor/register.js'
import 'monaco-editor/languages/definitions/redis/register.js'
import 'monaco-editor/languages/definitions/redshift/register.js'
import 'monaco-editor/languages/definitions/restructuredtext/register.js'
import 'monaco-editor/languages/definitions/ruby/register.js'
import 'monaco-editor/languages/definitions/rust/register.js'
import 'monaco-editor/languages/definitions/sb/register.js'
import 'monaco-editor/languages/definitions/scala/register.js'
import 'monaco-editor/languages/definitions/scheme/register.js'
import 'monaco-editor/languages/definitions/scss/register.js'
import 'monaco-editor/languages/definitions/shell/register.js'
import 'monaco-editor/languages/definitions/solidity/register.js'
import 'monaco-editor/languages/definitions/sophia/register.js'
import 'monaco-editor/languages/definitions/sparql/register.js'
import 'monaco-editor/languages/definitions/sql/register.js'
import 'monaco-editor/languages/definitions/st/register.js'
import 'monaco-editor/languages/definitions/swift/register.js'
import 'monaco-editor/languages/definitions/systemverilog/register.js'
import 'monaco-editor/languages/definitions/tcl/register.js'
import 'monaco-editor/languages/definitions/twig/register.js'
import 'monaco-editor/languages/definitions/typescript/register.js'
import 'monaco-editor/languages/definitions/typespec/register.js'
import 'monaco-editor/languages/definitions/vb/register.js'
import 'monaco-editor/languages/definitions/wgsl/register.js'
import 'monaco-editor/languages/definitions/xml/register.js'
import 'monaco-editor/languages/definitions/yaml/register.js'
import 'monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js'
import 'monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/transpose.js'
import 'monaco-editor/editor/contrib/clipboard/browser/clipboard.js'
import 'monaco-editor/editor/contrib/codeAction/browser/codeActionContributions.js'
import 'monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js'
import 'monaco-editor/editor/contrib/codelens/browser/codelensController.js'
import 'monaco-editor/editor/contrib/colorPicker/browser/colorPickerContribution.js'
import 'monaco-editor/editor/contrib/comment/browser/comment.js'
import 'monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js'
import 'monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js'
import 'monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js'
import 'monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js'
import 'monaco-editor/editor/contrib/dnd/browser/dnd.js'
import 'monaco-editor/editor/contrib/documentSymbols/browser/documentSymbols.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/dropIntoEditorContribution.js'
import 'monaco-editor/features/find/register.js'
import 'monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js'
import 'monaco-editor/editor/contrib/folding/browser/folding.js'
import 'monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js'
import 'monaco-editor/editor/contrib/format/browser/formatActions.js'
import 'monaco-editor/editor/contrib/gotoError/browser/gotoError.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/link/goToDefinitionAtPosition.js'
import 'monaco-editor/editor/contrib/gpu/browser/gpuActions.js'
import 'monaco-editor/editor/contrib/hover/browser/hoverContribution.js'
import 'monaco-editor/editor/contrib/indentation/browser/indentation.js'
import 'monaco-editor/editor/contrib/inlayHints/browser/inlayHintsContribution.js'
import 'monaco-editor/editor/contrib/inlineCompletions/browser/inlineCompletions.contribution.js'
import 'monaco-editor/editor/contrib/inlineProgress/browser/inlineProgress.js'
import 'monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js'
import 'monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js'
import 'monaco-editor/editor/standalone/browser/inspectTokens/inspectTokens.js'
import 'monaco-editor/editor/standalone/browser/iPadShowKeyboard/iPadShowKeyboard.js'
import 'monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js'
import 'monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js'
import 'monaco-editor/editor/contrib/linkedEditing/browser/linkedEditing.js'
import 'monaco-editor/editor/contrib/links/browser/links.js'
import 'monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js'
import 'monaco-editor/editor/contrib/middleScroll/browser/middleScroll.contribution.js'
import 'monaco-editor/editor/contrib/multicursor/browser/multicursor.js'
import 'monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js'
import 'monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js'
import 'monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js'
import 'monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js'
import 'monaco-editor/editor/standalone/browser/referenceSearch/standaloneReferenceSearch.js'
import 'monaco-editor/editor/contrib/rename/browser/rename.js'
import 'monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/viewportSemanticTokens.js'
import 'monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js'
import 'monaco-editor/editor/contrib/snippet/browser/snippetController2.js'
import 'monaco-editor/editor/contrib/stickyScroll/browser/stickyScrollContribution.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestInlineCompletions.js'
import 'monaco-editor/editor/standalone/browser/toggleHighContrast/toggleHighContrast.js'
import 'monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js'
import 'monaco-editor/editor/contrib/tokenization/browser/tokenization.js'
import 'monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js'
import 'monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js'
import 'monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js'
import 'monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js'
import 'monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js'
import 'monaco-editor/editor/browser/coreCommands.js'
import 'monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js'
import 'monaco-editor/editor/contrib/dropOrPasteInto/browser/copyPasteContribution.js'
import 'monaco-editor/editor/contrib/find/browser/findController.js'
import 'monaco-editor/editor/contrib/gotoSymbol/browser/goToCommands.js'
import 'monaco-editor/editor/contrib/gotoError/browser/markerSelectionStatus.js'
import 'monaco-editor/editor/contrib/semanticTokens/browser/documentSemanticTokens.js'
import 'monaco-editor/editor/contrib/suggest/browser/suggestController.js'
import 'monaco-editor/editor/common/standaloneStrings.js'
import * as monaco from 'monaco-editor/editor/editor.api.js'
import { extensionLanguageOf } from './vsxcontrib'
import { escapeHtml, joinPath, tiny } from '@tiny/sdk'
import { AS_LANGUAGE, setupAssemblyScript } from './as-language'
import { currentPalette, type Palette } from './themes'
import { PEAR_DTS } from './pear-types'
import { cssDefaults, lessDefaults, scssDefaults } from 'monaco-editor/language/css/monaco.contribution.js'
import { htmlDefaults } from 'monaco-editor/language/html/monaco.contribution.js'
import { jsonDefaults } from 'monaco-editor/language/json/monaco.contribution.js'
import { JsxEmit, ModuleKind, ModuleResolutionKind, ScriptTarget, javascriptDefaults, typescriptDefaults } from 'monaco-editor/language/typescript/monaco.contribution.js'
import { conf as tsConf, language as tsGrammar } from 'monaco-editor/languages/definitions/typescript/typescript.js'

// ---- language workers
// IntelliSense, diagnostics, formatting and colour decorators run in Monaco's own workers, bundled
// into the app as `Resources/workers/*.js` (tools/generate.mjs). A window cannot start a worker from
// a URL, so each script is read from the bundle and started from a blob, once per kind.
const WORKER_FILES: Record<string, string> = {
  typescript: 'ts', javascript: 'ts', css: 'css', scss: 'css', less: 'css', html: 'html', handlebars: 'html', razor: 'html', json: 'json',
}
const workerSources = new Map<string, Promise<string>>()
function workerUrl(kind: string): Promise<string> {
  let url = workerSources.get(kind)
  if (!url) {
    url = (async () => {
      const bundle = await tiny.bundleInfo('org.tiny.code')
      const bytes = await tiny.readFile(joinPath(bundle.path, `Resources/workers/${kind}.worker.js`))
      return URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'text/javascript' }))
    })()
    workerSources.set(kind, url)
  }
  return url
}
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: async (_id: string, label: string) => new Worker(await workerUrl(WORKER_FILES[label] ?? 'editor')),
}

/** Schema for a Pear app's manifest.json (docs/sdk.md): completion, hover and validation. */
const MANIFEST_SCHEMA = {
  type: 'object',
  required: ['id', 'name'],
  properties: {
    id: { type: 'string', description: 'Bundle identifier, reverse-DNS style (org.example.notes).' },
    name: { type: 'string', description: 'The name shown in the Dock, menu bar and Finder.' },
    version: { type: 'string', description: 'Semantic version of the app.' },
    kind: { enum: ['app'], description: 'What the bundle is.' },
    icon: { type: 'string', description: 'Path of the icon inside the bundle (SVG or PNG).' },
    ui: { type: 'string', description: "The window's page, relative to the bundle (Resources/ui/index.html)." },
    entry: { type: 'string', description: "The app's process script. Defaults to the standard host." },
    minify: { type: 'boolean', description: 'Bundle scripts minified.' },
    window: {
      type: 'object',
      description: 'Size hints for new windows.',
      properties: {
        width: { type: 'number' },
        height: { type: 'number' },
        minWidth: { type: 'number' },
        minHeight: { type: 'number' },
      },
    },
    permissions: {
      type: 'array',
      description: 'What the app may do. Ask for the least you need.',
      items: { enum: ['fs.container', 'fs.user', 'fs.picker', 'fs.all', 'clipboard', 'notifications', 'network', 'process.spawn', 'audio.input', 'video.input', 'location', 'display.capture'] },
    },
  },
}

let languagesReady = false
export function initLanguages(): void {
  if (languagesReady) return
  languagesReady = true
  // AssemblyScript reads like TypeScript but is not: its files get TypeScript colours without the
  // TypeScript checker (`i32`, `@inline` and friends would all be reported as errors)
  monaco.languages.register({ id: AS_LANGUAGE, aliases: ['AssemblyScript'] })
  monaco.languages.setMonarchTokensProvider(AS_LANGUAGE, tsGrammar)
  monaco.languages.setLanguageConfiguration(AS_LANGUAGE, tsConf)
  // ... and its own language service: a second TypeScript worker with AssemblyScript's libraries
  setupAssemblyScript(async () => {
    const bundle = await tiny.bundleInfo('org.tiny.code')
    const std = new TextDecoder().decode(await tiny.readFile(joinPath(bundle.path, 'Resources/workers/as-std.d.txt')))
    return { worker: await workerUrl('ts'), std }
  })

  const compilerOptions = {
    target: ScriptTarget.ES2020,
    module: ModuleKind.ESNext,
    moduleResolution: ModuleResolutionKind.NodeJs,
    allowJs: true,
    allowNonTsExtensions: true,
    checkJs: true,
    jsx: JsxEmit.Preserve,
    noEmit: true,
    lib: ['es2020', 'dom', 'dom.iterable'],
  }
  for (const defaults of [typescriptDefaults, javascriptDefaults]) {
    defaults.setCompilerOptions(compilerOptions)
    defaults.setEagerModelSync(true) // every project file is known to the checker, not just the open tabs
    // 7043-7050: "implicitly has an 'any' type, but a better type may be inferred" hints, which every untyped JS parameter earns
    defaults.setDiagnosticsOptions({ noSemanticValidation: false, noSyntaxValidation: false, diagnosticCodesToIgnore: [7043, 7044, 7045, 7046, 7047, 7048, 7049, 7050] })
    defaults.addExtraLib(PEAR_DTS, 'file:///node_modules/@types/pear/index.d.ts')
  }
  for (const css of [cssDefaults, scssDefaults, lessDefaults]) css.setOptions({ validate: true, lint: { unknownProperties: 'warning' } })
  htmlDefaults.setOptions({ format: { tabSize: 2, insertSpaces: true, wrapLineLength: 120 }, suggest: { html5: true } })
  jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    schemas: [{ uri: 'pear://schemas/manifest.json', fileMatch: ['*/manifest.json', 'manifest.json'], schema: MANIFEST_SCHEMA }],
  })
}

const LANGS: Array<[RegExp, string]> = [
  [/\.d\.ts$/, 'typescript'],
  [/\.(m|c)?tsx?$/, 'typescript'],
  [/\.(m|c)?jsx?$/, 'javascript'],
  [/\.jsonc?$/, 'json'],
  [/\.(le|sc)ss$/, 'css'],
  [/\.css$/, 'css'],
  [/\.scss$/, 'scss'],
  [/\.less$/, 'less'],
  [/\.html?$/, 'html'],
  [/\.svg$/, 'xml'],
  [/\.xml$/, 'xml'],
  [/\.md$/, 'markdown'],
  [/\.wasm?$/, 'wat'],
  [/\.wat$/, 'wat'],
  [/\.sh$/, 'shell'],
  [/\.ya?ml$/, 'yaml'],
]
let assemblyScriptProject = false
/** Whether the open project is an AssemblyScript one (its `src/main.ts` is). Decides how `src/**.ts` is treated. */
export const setAssemblyScriptProject = (yes: boolean): void => void (assemblyScriptProject = yes)
/** The marks of AssemblyScript source: its numeric types and decorators. */
export const looksLikeAssemblyScript = (text: string): boolean => /\b(i8|i16|i32|i64|u8|u16|u32|u64|f32|f64|usize|isize)\b|@(inline|global|external|unsafe|unmanaged|operator)\b/.test(text)

export function languageOf(path: string): string | undefined {
  // AssemblyScript reads like TypeScript but is not, and has its own service (as-language.ts)
  if (assemblyScriptProject && /^(src|assembly)\//.test(path) && /\.ts$/.test(path) && !path.endsWith('.d.ts')) return AS_LANGUAGE
  return LANGS.find(([re]) => re.test(path))?.[1] ?? extensionLanguageOf(path)
}

const bare = (c: string): string => c.replace('#', '')

/** Monaco wants hex colours: turn `rgba(r, g, b, a)` into `#rrggbbaa`. */
function hex8(c: string): string {
  const m = c.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/)
  if (!m) return c
  const h = (n: number): string => Math.round(n).toString(16).padStart(2, '0')
  return `#${h(+m[1]!)}${h(+m[2]!)}${h(+m[3]!)}${h(m[4] === undefined ? 255 : +m[4] * 255)}`
}

/** (Re)define Monaco's theme from a workbench palette; called at boot and whenever the theme changes. */
export function syncTheme(p: Palette): void {
  const { syn } = p
  monaco.editor.defineTheme('pear', {
    base: p.dark ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: '', foreground: bare(p.fg) },
      { token: 'comment', foreground: bare(syn.comment), fontStyle: 'italic' },
      { token: 'string', foreground: bare(syn.string) },
      { token: 'string.escape', foreground: bare(syn.number) },
      { token: 'regexp', foreground: bare(syn.string) },
      { token: 'number', foreground: bare(syn.number) },
      { token: 'constant', foreground: bare(syn.constant) },
      { token: 'keyword', foreground: bare(syn.keyword) },
      { token: 'operator', foreground: bare(syn.keyword) },
      { token: 'delimiter', foreground: bare(p.fg) },
      { token: 'delimiter.bracket', foreground: bare(p.fg) },
      { token: 'type', foreground: bare(syn.type) },
      { token: 'type.identifier', foreground: bare(syn.type) },
      { token: 'identifier', foreground: bare(p.fg) },
      { token: 'variable', foreground: bare(syn.variable) },
      { token: 'predefined', foreground: bare(syn.func) },
      { token: 'function', foreground: bare(syn.func) },
      { token: 'tag', foreground: bare(syn.tag) },
      { token: 'metatag', foreground: bare(syn.keyword) },
      { token: 'attribute.name', foreground: bare(syn.attr) },
      { token: 'attribute.value', foreground: bare(syn.string) },
      { token: 'key', foreground: bare(syn.attr) },
    ],
    colors: {
      'editor.background': p.bg,
      'editor.foreground': p.fg,
      'editorLineNumber.foreground': p.lineNumber,
      'editorLineNumber.activeForeground': p.fg,
      'editor.selectionBackground': p.selection,
      'editor.inactiveSelectionBackground': p.selection,
      'editor.lineHighlightBackground': hex8(p.lineHighlight),
      'editor.lineHighlightBorder': '#00000000',
      'editorCursor.foreground': p.cursor,
      'editorWhitespace.foreground': p.fgSubtle + '55',
      'editorIndentGuide.background1': p.border,
      'editorIndentGuide.activeBackground1': p.fgSubtle,
      'editorBracketMatch.background': p.selection,
      'editorBracketMatch.border': '#00000000',
      'editorGutter.background': p.bg,
      'editorWidget.background': p.bgAlt,
      'editorWidget.border': p.border,
      'editorSuggestWidget.background': p.bgAlt,
      'editorSuggestWidget.border': p.border,
      'editorSuggestWidget.selectedBackground': hex8(p.select),
      'editorHoverWidget.background': p.bgAlt,
      'editorHoverWidget.border': p.border,
      'editor.findMatchBackground': p.warning + '66',
      'editor.findMatchHighlightBackground': p.warning + '33',
      'editor.wordHighlightBackground': p.selection,
      'input.background': p.bgInset,
      'input.border': p.border,
      'input.foreground': p.fg,
      'focusBorder': p.accent,
      'list.hoverBackground': hex8(p.hover),
      'list.activeSelectionBackground': hex8(p.select),
      'list.focusBackground': hex8(p.select),
      'scrollbarSlider.background': '#7f7f7f44',
      'scrollbarSlider.hoverBackground': '#7f7f7f80',
      'scrollbarSlider.activeBackground': '#7f7f7fa0',
      'minimap.background': p.bg,
      'minimap.selectionHighlight': p.accentFg,
      'widget.shadow': '#0000004d',
    },
  })
  monaco.editor.setTheme('pear')
}

export interface EditorTab {
  path: string
  model: monaco.editor.ITextModel
  saved: number
}

export class CodeEditor {
  private editor: monaco.editor.IStandaloneCodeEditor | null = null
  private tabs = new Map<string, EditorTab>()

  constructor(
    private container: HTMLElement,
    private onChange: (path: string, dirty: boolean) => void,
    private onCursor: (line: number, col: number) => void,
    private onSave: () => void,
  ) {}

  private ensure(): monaco.editor.IStandaloneCodeEditor {
    if (this.editor) return this.editor
    const host = document.createElement('div')
    host.className = 'monaco-host'
    this.container.append(host)
    this.editor = monaco.editor.create(host, {
      model: null,
      automaticLayout: true,
      // VS Code's macOS defaults
      fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--vsc-mono').trim() || 'Menlo, Monaco, monospace',
      fontSize: 12,
      lineHeight: 18,
      minimap: { enabled: true, renderCharacters: false, maxColumn: 80 },
      scrollBeyondLastLine: true,
      links: false,
      renderLineHighlight: 'all',
      renderWhitespace: 'selection',
      bracketPairColorization: { enabled: true },
      guides: { indentation: true, bracketPairs: false },
      cursorBlinking: 'smooth',
      smoothScrolling: true,
      padding: { top: 0 },
      lineNumbersMinChars: 4,
      glyphMargin: false,
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    })
    this.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => this.onSave())
    this.addWorkbenchKeys(this.editor)
    this.editor.onDidChangeCursorPosition((e) => this.onCursor(e.position.lineNumber, e.position.column))
    syncTheme(currentPalette())
    return this.editor
  }

  /** Called for workbench keys that Monaco would otherwise take for itself (F1, Cmd+K chords): the command id. */
  onWorkbenchKey: (command: string) => void = () => {}

  /**
   * Monaco treats Cmd+K as the start of its own chords (fold, ...) and F1 as its palette, so a key that
   * the workbench owns has to be claimed here to work while the editor has focus.
   */
  private addWorkbenchKeys(ed: monaco.editor.IStandaloneCodeEditor): void {
    const { KeyMod, KeyCode } = monaco
    const chord = (second: number): number => KeyMod.chord(KeyMod.CtrlCmd | KeyCode.KeyK, second)
    const claim = (key: number, command: string): void => void ed.addCommand(key, () => this.onWorkbenchKey(command))
    claim(KeyCode.F1, 'workbench.action.showCommands')
    claim(KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyP, 'workbench.action.showCommands')
    claim(chord(KeyMod.CtrlCmd | KeyCode.KeyS), 'workbench.action.openGlobalKeybindings')
    claim(chord(KeyMod.CtrlCmd | KeyCode.KeyT), 'workbench.action.selectTheme')
    claim(chord(KeyMod.CtrlCmd | KeyCode.KeyW), 'workbench.action.closeAllEditors')
    claim(chord(KeyCode.KeyV), 'markdown.showPreviewToSide')
    claim(chord(KeyCode.KeyW), 'workbench.action.closeAllEditors')
  }

  /** Monaco's own commands, for the command palette. */
  actions(): Array<{ id: string; label: string }> {
    return (this.editor?.getSupportedActions() ?? []).map((a) => ({ id: a.id, label: a.label }))
  }

  toggleWordWrap(): boolean {
    if (!this.editor) return false
    const on = this.editor.getOption(monaco.editor.EditorOption.wordWrap) !== 'off'
    this.editor.updateOptions({ wordWrap: on ? 'off' : 'on' })
    return !on
  }

  focus(): void {
    this.editor?.focus()
  }

  revealLine(line: number): void {
    this.editor?.revealLineInCenter(line)
    this.editor?.setPosition({ lineNumber: line, column: 1 })
    this.editor?.focus()
  }

  activePath(): string | null {
    for (const [path, tab] of this.tabs) if (this.editor?.getModel() === tab.model) return path
    return null
  }

  isDirty(path: string): boolean {
    const tab = this.tabs.get(path)
    return !!tab && tab.model.getVersionId() !== tab.saved
  }

  allDirty(): string[] {
    return [...this.tabs.keys()].filter((p) => this.isDirty(p))
  }

  value(path: string): string | null {
    return this.tabs.get(path)?.model.getValue() ?? null
  }

  /** The model for `path`, created on first use. Files nobody has open still get a model, so the language services see the whole project. */
  private ensureTab(path: string, text: string): EditorTab {
    let tab = this.tabs.get(path)
    if (!tab) {
      const model = monaco.editor.createModel(text, languageOf(path), monaco.Uri.parse(`file:///${path.replace(/^\//, '')}`))
      model.onDidChangeContent(() => {
        this.onChange(path, this.isDirty(path))
        if (this.activePath() === path) this.reportCursor()
      })
      tab = { path, model, saved: model.getVersionId() }
      this.tabs.set(path, tab)
    }
    return tab
  }

  /** Make the project file known to the language services without showing it. */
  addBackground(path: string, text: string): void {
    this.ensureTab(path, text)
  }

  paths(): string[] {
    return [...this.tabs.keys()]
  }

  has(path: string): boolean {
    return this.tabs.has(path)
  }

  open(path: string, text: string): void {
    const ed = this.ensure()
    const tab = this.ensureTab(path, text)
    ed.setModel(tab.model)
    ed.focus()
  }

  /** Scroll to a position and put the caret there. */
  reveal(line: number, col: number): void {
    this.editor?.setPosition({ lineNumber: line, column: col })
    this.editor?.revealPositionInCenter({ lineNumber: line, column: col })
    this.editor?.focus()
  }

  /** Run one of Monaco's actions (`editor.action.formatDocument`, `actions.find`...). */
  run(actionId: string): void {
    void this.editor?.getAction(actionId)?.run()
  }

  /** Text of the whole model, even when no tab shows it. */
  setLanguageFor(path: string): string | null {
    return this.tabs.get(path)?.model.getLanguageId() ?? null
  }

  /** The text and version to write: pass the version back to `markSaved`, so edits made during the write stay unsaved. */
  snapshot(path: string): { text: string; version: number } | null {
    const tab = this.tabs.get(path)
    return tab ? { text: tab.model.getValue(), version: tab.model.getVersionId() } : null
  }

  markSaved(path: string, version?: number): void {
    const tab = this.tabs.get(path)
    if (tab) tab.saved = version ?? tab.model.getVersionId()
  }

  /** Replace a file's text and call it saved (reverting to what is on disk). */
  setSavedValue(path: string, text: string): void {
    const tab = this.tabs.get(path)
    if (!tab) return
    tab.model.setValue(text)
    tab.saved = tab.model.getVersionId()
    this.onChange(path, false)
  }

  close(path: string): void {
    const tab = this.tabs.get(path)
    if (!tab) return
    if (this.editor?.getModel() === tab.model) {
      const rest = [...this.tabs.keys()].filter((p) => p !== path)
      this.editor.setModel(rest.length ? this.tabs.get(rest[rest.length - 1]!)!.model : null)
    }
    tab.model.dispose()
    this.tabs.delete(path)
  }

  closeAll(): void {
    for (const p of [...this.tabs.keys()]) this.close(p)
  }

  reportCursor(): void {
    const pos = this.editor?.getPosition()
    if (pos) this.onCursor(pos.lineNumber, pos.column)
  }

  layout(): void {
    void this.editor?.layout()
  }
}

/** Toolbar-safe HTML for a file name with its extension dimmed. */
export function fileLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? `${escapeHtml(name.slice(0, dot))}<span class="ext">${escapeHtml(name.slice(dot))}</span>` : escapeHtml(name)
}

// ---- problems: what the language services report across the project

export interface Problem {
  path: string
  severity: 'error' | 'warning' | 'info'
  message: string
  line: number
  col: number
  source: string
}

export function problems(): Problem[] {
  return monaco.editor
    .getModelMarkers({})
    .filter((m) => m.resource.scheme === 'file' && !m.resource.path.startsWith('/node_modules/'))
    .map((m) => ({
      path: m.resource.path.replace(/^\//, ''),
      severity: m.severity === monaco.MarkerSeverity.Error ? ('error' as const) : m.severity === monaco.MarkerSeverity.Warning ? ('warning' as const) : ('info' as const),
      message: m.message,
      line: m.startLineNumber,
      col: m.startColumn,
      source: m.source ?? '',
    }))
    .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line)
}

/** Show compiler errors as markers in the files they point at; an empty list clears them. */
export function setBuildProblems(items: Array<{ path: string; line: number; col: number; endCol: number; message: string; severity: 'error' | 'warning' }>, source: string): void {
  for (const m of monaco.editor.getModels()) {
    const path = m.uri.path.replace(/^\//, '')
    monaco.editor.setModelMarkers(
      m,
      'build',
      items
        .filter((i) => i.path === path)
        .map((i) => ({
          severity: i.severity === 'error' ? monaco.MarkerSeverity.Error : monaco.MarkerSeverity.Warning,
          message: i.message,
          startLineNumber: i.line,
          startColumn: i.col,
          endLineNumber: i.line,
          endColumn: Math.max(i.endCol, i.col + 1),
          source,
        })),
    )
  }
}

export const onProblemsChanged = (fn: () => void): void => void monaco.editor.onDidChangeMarkers(fn)
