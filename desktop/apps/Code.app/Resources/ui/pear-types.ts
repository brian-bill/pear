// Type declarations for the Pear app API, handed to the TypeScript service so `tiny` completes and
// type-checks in every project (apps see it as a global; see docs/sdk.md). Kept deliberately
// small: the calls apps use day to day, not the whole kernel surface.

export const PEAR_DTS = `
interface PearStat { kind: 'file' | 'dir' | 'symlink'; size: number; mtime: number; mode: number }
interface PearDirEntry { name: string; kind: 'file' | 'dir' | 'symlink' }
interface PearTheme { dark: boolean; accent: string; reduceMotion: boolean; reduceTransparency: boolean; vars: Record<string, string> }
interface PearAlertOptions { title?: string; message: string; detail?: string; buttons?: string[]; defaultButton?: number; cancelButton?: number }
interface PearPickOptions { title?: string; startIn?: string; button?: string; filters?: Array<{ name: string; ext: string[] }>; multiple?: boolean }
interface PearMenuItem { label?: string; shortcut?: string; action?: () => void | Promise<void>; disabled?: boolean; checked?: boolean; separator?: boolean }

interface PearApi {
  /** Resolves when the window is connected to Desktop. */
  ready: Promise<unknown>
  /** Read a file. Relative paths resolve against the app's container. */
  readFile(path: string): Promise<Uint8Array<ArrayBuffer>>
  writeFile(path: string, data: Uint8Array | string): Promise<void>
  readdir(path: string): Promise<PearDirEntry[]>
  stat(path: string): Promise<PearStat>
  exists(path: string): Promise<boolean>
  mkdir(path: string, options?: { recursive?: boolean }): Promise<void>
  unlink(path: string): Promise<void>
  removeAll(path: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  copy(from: string, to: string): Promise<void>
  getenv(name: string): Promise<string | undefined>
  /** Per-app settings. */
  configGet<T = unknown>(app: string, key: string, fallback?: T): Promise<T>
  configSet(app: string, key: string, value: unknown): Promise<void>
  window: {
    readonly id: number
    setTitle(title: string): Promise<void>
    setMenus(menus: Array<{ title: string; items: PearMenuItem[] }>): Promise<void>
    setEdited(edited: boolean): Promise<void>
    onCloseRequest(fn: () => boolean | void | Promise<boolean | void>): () => void
    close(): Promise<void>
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    resize(width: number, height: number): Promise<void>
  }
  app: {
    readonly id: string
    readonly name: string
    readonly args: unknown[]
    readonly state: unknown
    onOpenFile(fn: (path: string) => void): () => void
    onSaveState(fn: () => unknown): () => void
    stateChanged(): Promise<void>
    quit(): Promise<void>
  }
  dialogs: {
    alert(options: PearAlertOptions | string): Promise<number>
    confirm(message: string, options?: Partial<PearAlertOptions>): Promise<boolean>
    prompt(message: string, options?: { value?: string; title?: string; placeholder?: string; button?: string }): Promise<string | null>
    openFile(options?: PearPickOptions): Promise<string[] | null>
    openFolder(options?: PearPickOptions): Promise<string[] | null>
    saveFile(options?: PearPickOptions & { name?: string }): Promise<string | null>
  }
  shell: {
    open(target: string, options?: { app?: string }): Promise<void>
    reveal(path: string): Promise<void>
    openApp(appId: string): Promise<void>
    notify(title: string, body?: string): Promise<number>
    contextMenu(items: PearMenuItem[], at: { x: number; y: number }): Promise<void>
  }
  /** Subscribe to Desktop events such as 'theme'. Returns an unsubscribe function. */
  on(name: string, fn: (data?: any) => unknown): () => void
  readonly theme: PearTheme
  readonly locale: string
  readonly platform: string
}

/** The Pear API, available to every app window. */
declare var tiny: PearApi
`
