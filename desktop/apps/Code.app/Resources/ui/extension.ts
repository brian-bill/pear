// A minimal extension model for Code: extensions activate with a host handle and contribute
// toolbar buttons plus reactions to project events. They are ordinary modules of the app.

export interface ExtHost {
  /** The open project directory (`~/Projects/Demo.app`), or null. */
  project(): string | null
  /** A project file's bytes by path relative to the project root, or null if missing. */
  readProjectFile(rel: string): Promise<Uint8Array | null>
  fileExists(rel: string): Promise<boolean>
  /** Append a line to the output panel. */
  log(line: string, cls?: 'err' | 'ok'): void
  showOutput(): void
  /** The editor's text for a project file that has unsaved edits, or null (then the file on disk is current). */
  buffer(rel: string): string | null
  /** Replace the build problems an extension reports (shown in the editor and the Problems panel). */
  problems(items: Array<{ path: string; line: number; col: number; endCol: number; message: string; severity: 'error' | 'warning' }>): void
  /** A transient status bar message. */
  status(text: string): void
}

export interface ToolbarButton {
  id: string
  label: string
  title: string
  primary?: boolean
  /** A codicon name; defaults to the run triangle. */
  icon?: import('./icons').IconName
  /** Re-evaluated whenever the project or selection changes. */
  visible(): boolean
  run(): void
}

export interface ExtActions {
  toolbar?: ToolbarButton[]
  /** A project was opened (or switched). */
  onDidOpenProject?(): void
  /** A project file was saved. */
  onDidSaveProject?(rel: string): void
  /** A file's text changed in the editor (debounced); it may not be saved yet. */
  onDidChangeFile?(rel: string): void
  /** The project was closed. */
  onDidCloseProject?(): void
}

export interface ExtensionDef {
  id: string
  name: string
  description: string
  /** Small marker like "built-in". */
  tag?: string
  installedByDefault: boolean
  activate(host: ExtHost): ExtActions
}
