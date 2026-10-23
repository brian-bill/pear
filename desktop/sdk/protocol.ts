/// Messages between an app's UI (a sandboxed iframe) and Desktop (the page), and between Desktop and the app's
/// process. Shared by `client.ts` (iframe), `host.ts` (process) and Desktop itself.

/** UI -> Desktop. `method` is namespaced: `kernel.<name>` runs in the app's process; the rest is Desktop's. */
export interface CallMsg {
  t: 'call'
  id: number
  method: string
  args: unknown[]
}
/** UI -> Desktop: something Desktop must react to (focus, shortcuts, pointer). */
export interface NoteMsg {
  t: 'note'
  kind: 'pointer' | 'focus' | 'key' | 'ready'
  data?: unknown
}
/** Desktop -> UI. */
export interface ReplyMsg {
  t: 'reply'
  id: number
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}
export interface EventMsg {
  t: 'event'
  name: string
  data?: unknown
  /** Present when Desktop waits for an answer (`saveState`, `closeRequest`). */
  reqId?: number
}
/** UI -> Desktop: the answer to an event that had a `reqId`. */
export interface AnswerMsg {
  t: 'answer'
  reqId: number
  value: unknown
}
export interface InitMsg {
  t: 'init'
  appId: string
  appName: string
  windowId: number
  /** State this window saved last time (session restore) or was opened with. */
  state: unknown
  args: string[]
  theme: ThemeInfo
  locale: string
  platform: string
}
export interface ThemeInfo {
  dark: boolean
  accent: string
  reduceMotion: boolean
  reduceTransparency: boolean
  /** The CSS custom properties of the current theme, by name. */
  vars: Record<string, string>
}

export type UiToDesktop = CallMsg | NoteMsg | AnswerMsg
export type DesktopToUi = ReplyMsg | EventMsg | InitMsg

/** A menu as an app describes it. `id`s come back as `menu` events. */
export interface MenuSpec {
  title: string
  items: MenuItemSpec[]
}
export interface MenuItemSpec {
  id?: string
  label?: string
  /** Display and match text such as `Cmd+S` or `Cmd+Shift+Z`. */
  shortcut?: string
  disabled?: boolean
  checked?: boolean
  separator?: boolean
}

/** Process stub (host.ts) requests, on the port named `ui.<appId>`. */
export type HostRequest =
  | { op: 'hello' }
  | { op: 'attach' } // rights[0]: the port events are sent to
  | { op: 'call'; method: string; args: unknown[] }
  | { op: 'service'; name: string; msg: unknown; timeout?: number }
export type HostReply = { ok: true; result: unknown } | { ok: false; error: { code: string; message: string } }

/** What the stub sends to the attached events port. */
export type HostEvent =
  | { type: 'openFile'; path: string }
  | { type: 'openURL'; url: string }
  | { type: 'activate' }
  | { type: 'save-state' }
