// Monaco's language-service entry points ship JavaScript without declarations. Only what Code uses
// is declared, and loosely: the options objects are validated by the services themselves.
interface MonacoLanguageDefaults {
  setOptions(options: object): void
  setDiagnosticsOptions(options: object): void
  setCompilerOptions(options: object): void
  setEagerModelSync(value: boolean): void
  addExtraLib(content: string, filePath?: string): { dispose(): void }
}

declare module 'monaco-editor/language/css/monaco.contribution.js' {
  export const cssDefaults: MonacoLanguageDefaults
  export const scssDefaults: MonacoLanguageDefaults
  export const lessDefaults: MonacoLanguageDefaults
}
declare module 'monaco-editor/language/html/monaco.contribution.js' {
  export const htmlDefaults: MonacoLanguageDefaults
}
declare module 'monaco-editor/language/json/monaco.contribution.js' {
  export const jsonDefaults: MonacoLanguageDefaults
}
declare module 'monaco-editor/language/typescript/monaco.contribution.js' {
  export const typescriptDefaults: MonacoLanguageDefaults
  export const javascriptDefaults: MonacoLanguageDefaults
  export const ScriptTarget: Record<string, number>
  export const ModuleKind: Record<string, number>
  export const ModuleResolutionKind: Record<string, number>
  export const JsxEmit: Record<string, number>
}
declare module 'monaco-editor/languages/definitions/typescript/typescript.js' {
  import type * as monaco from 'monaco-editor'
  export const conf: monaco.languages.LanguageConfiguration
  export const language: monaco.languages.IMonarchLanguage
}
