/// Permissions: Unix mode bits checked on every file call a non-root process makes, capabilities declared in app
/// manifests and granted by the user, and an audit log of what was granted and denied.
import type { BundleInfo } from './bundle'
import { SysError } from './errors'
import { O, type FileSystem, type Stat } from './fs'
import type { Credentials, UserDb } from './users'

export const CAPABILITIES = [
  'fs.container', 'fs.user', 'fs.picker', 'fs.all',
  'clipboard', 'notifications', 'audio.input', 'video.input', 'network', 'location', 'process.spawn', 'display.capture',
] as const
export type Capability = (typeof CAPABILITIES)[number]
export type Status = 'granted' | 'denied' | 'prompt'

export interface Grant {
  appId: string
  capability: Capability
  status: Status
  /** Last change, ms since the epoch. 0 if the user was never asked. */
  at: number
}

export interface AuditEntry {
  time: number
  event: 'grant' | 'deny' | 'revoke' | 'prompt' | 'fs-denied' | 'cap-denied'
  appId: string | null
  pid: number | null
  capability?: string
  path?: string
  call?: string
  detail?: string
}

export type PermissionEvent =
  | { type: 'permission'; event: 'prompt'; id: number; appId: string; appName: string; capability: Capability; pid: number | null }
  | { type: 'permission'; event: 'changed'; appId: string; capability: Capability; status: Status }
  | { type: 'permission'; event: 'audit'; entry: AuditEntry }

/** Who is making a call. Processes outside any app (system services, tools, the shell) have `appId: null`. */
export interface Subject extends Credentials {
  pid: number | null
  appId: string | null
}

const GRANTS_FILE = '/var/db/permissions.json'
const AUDIT_FILE = '/var/log/audit.log'
const AUDIT_RING = 1000
const PROMPT_TIMEOUT_MS = 30_000
const AUDIT_FLUSH_MS = 250

/** Read-only for apps: the system, programs, and the list of apps. */
const SHARED_READONLY = ['/System', '/bin', '/usr', '/etc', '/Applications']
const SHARED_WRITABLE = ['/tmp']

const R = 4
const W = 2
const X = 1
const STICKY = 0o1000
const MAX_TREE_CHECK = 20_000

type Level = 'rw' | 'ro' | 'ancestor'
export interface FsScope {
  rw: string[]
  ro: string[]
}

const isUnder = (path: string, root: string) => root === '/' || path === root || path.startsWith(`${root}/`)
const dirname = (p: string) => (p.lastIndexOf('/') <= 0 ? '/' : p.slice(0, p.lastIndexOf('/')))
const basename = (p: string) => p.slice(p.lastIndexOf('/') + 1)
const join = (a: string, b: string) => (a === '/' ? `/${b}` : `${a}/${b}`)

/** Collapse `.` and `..` and repeated slashes in an absolute path. */
export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** Whether `mode` bits give the subject read, write, or search/execute. Root passes, except that nothing is executable without an x bit. */
function modeAllows(st: Pick<Stat, 'mode' | 'uid' | 'gid' | 'kind'>, who: Credentials, want: number): boolean {
  if (who.uid === 0) return want !== X || st.kind === 'dir' || (st.mode & 0o111) !== 0
  const shift = st.uid === who.uid ? 6 : who.gid === st.gid || who.groups.includes(st.gid) ? 3 : 0
  return (((st.mode >> shift) & 7) & want) === want
}

type Op = 'search' | 'read' | 'write' | 'create' | 'delete'
interface Need {
  path: string
  op: Op
  /** Do not follow a symlink in the last component. */
  nofollow?: boolean
  /** Only a check if the name is new (a write to an existing file is a `write`). */
  soft?: boolean
}

export class Permissions {
  private grants = new Map<string, Map<Capability, Grant>>()
  private pickers = new Map<string, Array<{ path: string; write: boolean }>>()
  private log: AuditEntry[] = []
  private unsaved: AuditEntry[] = []
  private auditTimer: ReturnType<typeof setTimeout> | undefined
  private writing: Promise<unknown> = Promise.resolve()
  private saveTimer: ReturnType<typeof setTimeout> | undefined
  private prompter = false
  private nextPrompt = 1
  private prompts = new Map<number, { appId: string; capability: Capability; resolve: (s: 'granted' | 'denied' | null) => void; timer: ReturnType<typeof setTimeout> }>()

  constructor(
    private fs: FileSystem,
    private users: UserDb,
    private bundle: (appId: string) => BundleInfo | undefined,
    private emit: (e: PermissionEvent) => void,
    private opts: { promptTimeout?: number } = {},
  ) {}

  // ------------------------------------------------------------------ persistence

  async load(): Promise<void> {
    this.grants.clear()
    try {
      const rows = JSON.parse(new TextDecoder().decode(await this.fs.readFile(GRANTS_FILE))) as Grant[]
      for (const g of rows) {
        if (CAPABILITIES.includes(g.capability) && (g.status === 'granted' || g.status === 'denied')) this.put(g)
      }
    } catch {
      // first boot, or damaged: nothing was granted
    }
  }

  private put(g: Grant): void {
    let m = this.grants.get(g.appId)
    if (!m) this.grants.set(g.appId, (m = new Map()))
    m.set(g.capability, g)
  }

  private save(): void {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => void this.saveNow(), 100)
  }

  async saveNow(): Promise<void> {
    clearTimeout(this.saveTimer)
    const rows = [...this.grants.values()].flatMap((m) => [...m.values()])
    const data = new TextEncoder().encode(JSON.stringify(rows))
    await this.enqueue(async () => {
      await this.fs.mkdir(dirname(GRANTS_FILE), { recursive: true, mode: 0o755 }).catch(() => {})
      await this.fs.writeFileAtomic(GRANTS_FILE, data)
    })
  }

  /** Persistence writes run one after another; a failed write is dropped (the next save writes everything again). */
  private enqueue(job: () => Promise<void>): Promise<unknown> {
    return (this.writing = this.writing.then(job).catch(() => {}))
  }

  // ------------------------------------------------------------------ capabilities

  /** What the user decided about `capability` for an app, or `prompt` if still open. Undeclared capabilities are denied. */
  status(appId: string, capability: Capability): Status {
    const app = this.bundle(appId)
    if (!app) return 'denied'
    if (capability === 'fs.container') return 'granted'
    if (!app.permissions.includes(capability)) return 'denied'
    return this.grants.get(appId)?.get(capability)?.status ?? 'prompt'
  }

  /** The state of a capability for whoever is calling. Processes outside any app hold every capability. */
  check(who: Subject, capability: string, scope?: string): Status {
    if (!CAPABILITIES.includes(capability as Capability)) throw new SysError('EINVAL', `unknown capability ${capability}`)
    if (!who.appId) return 'granted'
    const cap = capability as Capability
    if (cap === 'fs.picker' && scope !== undefined) {
      const path = normalize(scope)
      return (this.pickers.get(who.appId) ?? []).some((p) => isUnder(path, p.path)) ? 'granted' : this.status(who.appId, cap) === 'denied' ? 'denied' : 'prompt'
    }
    return this.status(who.appId, cap)
  }

  /** Deny a call that needs a capability the caller does not hold. */
  require(who: Subject, capability: Capability, call: string): void {
    if (this.check(who, capability) === 'granted') return
    this.audit({ event: 'cap-denied', appId: who.appId, pid: who.pid, capability, call })
    throw new SysError('EPERM', `${call} needs the ${capability} permission`)
  }

  /**
   * Ask for a capability, showing the prompt if the user has not decided. With no prompt handler, or no answer in
   * time, the answer is `denied` but nothing is remembered: the user never chose.
   */
  async request(who: Subject, capability: string): Promise<Status> {
    const now = this.check(who, capability)
    if (now !== 'prompt' || !who.appId) return now
    const cap = capability as Capability
    const answer = await this.ask(who.appId, cap, who.pid)
    if (answer === null) return 'denied'
    this.decide(who.appId, cap, answer)
    return answer
  }

  /** The user's answer, or `null` if nobody could be asked or nobody answered. */
  private ask(appId: string, capability: Capability, pid: number | null): Promise<'granted' | 'denied' | null> {
    if (!this.prompter) {
      this.audit({ event: 'deny', appId, pid, capability, detail: 'no prompt handler' })
      return Promise.resolve(null)
    }
    const id = this.nextPrompt++
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.prompts.delete(id)
        this.audit({ event: 'deny', appId, pid, capability, detail: 'prompt timed out' })
        resolve(null)
      }, this.opts.promptTimeout ?? PROMPT_TIMEOUT_MS)
      this.prompts.set(id, { appId, capability, resolve, timer })
      this.audit({ event: 'prompt', appId, pid, capability })
      this.emit({ type: 'permission', event: 'prompt', id, appId, appName: this.bundle(appId)?.name ?? appId, capability, pid })
    })
  }

  /** Desktop says whether it can show prompts. Without it every request is denied. */
  setPrompter(on: boolean): void {
    this.prompter = on
    if (on) return
    for (const id of [...this.prompts.keys()]) this.cancel(id)
  }

  private cancel(id: number): void {
    const p = this.prompts.get(id)
    if (!p) return
    this.prompts.delete(id)
    clearTimeout(p.timer)
    this.audit({ event: 'deny', appId: p.appId, pid: null, capability: p.capability, detail: 'prompt cancelled' })
    p.resolve(null)
  }

  respond(id: number, answer: 'granted' | 'denied'): void {
    const p = this.prompts.get(id)
    if (!p) throw new SysError('ENOENT', 'no such prompt')
    this.prompts.delete(id)
    clearTimeout(p.timer)
    p.resolve(answer)
  }

  /** Settings: switch a declared capability on or off. */
  decide(appId: string, capability: Capability, status: 'granted' | 'denied'): void {
    const app = this.bundle(appId)
    if (!app) throw new SysError('ENOENT', `no app with id ${appId}`)
    if (capability !== 'fs.container' && !app.permissions.includes(capability)) throw new SysError('EPERM', `${app.name} did not declare ${capability}`)
    if (capability === 'fs.container' && status === 'denied') throw new SysError('EINVAL', 'the container cannot be revoked')
    this.put({ appId, capability, status, at: Date.now() })
    this.audit({ event: status === 'granted' ? 'grant' : 'deny', appId, pid: null, capability })
    this.emit({ type: 'permission', event: 'changed', appId, capability, status })
    this.save()
  }

  /** Revoke: the capability is denied from now on. The caller closes handles that depended on it. */
  revoke(appId: string, capability: Capability): void {
    this.decide(appId, capability, 'denied')
    this.audit({ event: 'revoke', appId, pid: null, capability })
  }

  reset(appId: string, capability: Capability): void {
    this.grants.get(appId)?.delete(capability)
    this.emit({ type: 'permission', event: 'changed', appId, capability, status: this.status(appId, capability) })
    this.save()
  }

  /** Grant every capability the manifest declares (system apps, or the user accepting an install prompt). */
  grantDeclared(appId: string): void {
    for (const cap of this.bundle(appId)?.permissions ?? []) this.decide(appId, cap, 'granted')
  }

  list(appId?: string): Grant[] {
    const ids = appId ? [appId] : [...this.grants.keys()]
    return ids.flatMap((id) => {
      const app = this.bundle(id)
      if (!app) return []
      const caps: Capability[] = ['fs.container', ...app.permissions]
      return [...new Set(caps)].map((capability) => ({
        appId: id,
        capability,
        status: this.status(id, capability),
        at: this.grants.get(id)?.get(capability)?.at ?? 0,
      }))
    })
  }

  /** A file or folder the user picked in an open or save panel: the app may use it, and everything below it. */
  pickerGrant(appId: string, path: string, opts: { write?: boolean } = {}): void {
    if (!this.bundle(appId)) throw new SysError('ENOENT', `no app with id ${appId}`)
    const list = this.pickers.get(appId) ?? []
    list.push({ path: normalize(path), write: opts.write !== false })
    this.pickers.set(appId, list)
    this.audit({ event: 'grant', appId, pid: null, capability: 'fs.picker', path })
  }

  /** The app's last process ended: its picked files are no longer reachable. */
  dropPickers(appId: string): void {
    this.pickers.delete(appId)
  }

  // ------------------------------------------------------------------ audit

  audit(entry: Omit<AuditEntry, 'time'>): void {
    const full: AuditEntry = { time: Date.now(), ...entry }
    this.log.push(full)
    if (this.log.length > AUDIT_RING) this.log.splice(0, this.log.length - AUDIT_RING)
    this.unsaved.push(full)
    this.emit({ type: 'permission', event: 'audit', entry: full })
    clearTimeout(this.auditTimer)
    this.auditTimer = setTimeout(() => void this.flushAudit(), AUDIT_FLUSH_MS)
  }

  recent(limit = 100): AuditEntry[] {
    return this.log.slice(-limit)
  }

  async flushAudit(): Promise<void> {
    clearTimeout(this.auditTimer)
    const lines = this.unsaved.splice(0).map((e) => JSON.stringify(e)).join('\n')
    if (!lines) {
      await this.writing
      return
    }
    const data = new TextEncoder().encode(`${lines}\n`)
    await this.enqueue(async () => {
      await this.fs.mkdir(dirname(AUDIT_FILE), { recursive: true, mode: 0o755 }).catch(() => {})
      const fd = await this.fs.open(AUDIT_FILE, O.WRONLY | O.CREAT | O.APPEND, 0o644)
      try {
        await this.fs.write(fd, data)
      } finally {
        await this.fs.close(fd)
      }
    })
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.prompts.keys()]) this.cancel(id)
    clearTimeout(this.saveTimer)
    await this.saveNow()
    await this.flushAudit()
  }

  // ------------------------------------------------------------------ file access

  /** Folders an app may touch, given its bundle and what the user granted. */
  scope(appId: string): FsScope {
    const app = this.bundle(appId)
    const home = this.users.primary.home
    const rw = [...SHARED_WRITABLE]
    const ro = [...SHARED_READONLY]
    if (!app) return { rw: [], ro: [] }
    ro.push(app.path)
    rw.push(app.container, app.supportDir)
    if (this.status(appId, 'fs.user') === 'granted') rw.push(home)
    if (this.status(appId, 'fs.all') === 'granted') rw.push('/')
    for (const p of this.pickers.get(appId) ?? []) (p.write ? rw : ro).push(p.path)
    return { rw, ro }
  }

  private level(scope: FsScope, path: string): Level | null {
    if (scope.rw.some((r) => isUnder(path, r))) return 'rw'
    if (scope.ro.some((r) => isUnder(path, r))) return 'ro'
    if ([...scope.rw, ...scope.ro].some((r) => isUnder(r, path))) return 'ancestor'
    return null
  }

  /** Would an app with this scope still be allowed to hold `path` open (for writing, if `write`)? */
  scopeAllows(appId: string, path: string, write: boolean): boolean {
    const level = this.level(this.scope(appId), path)
    return write ? level === 'rw' : level === 'rw' || level === 'ro'
  }

  /**
   * Canonical form of `path` (symlinks followed), plus the trailing names that do not exist yet. With `nofollow`
   * a link in the last position is not followed (it is the thing being removed, renamed, or read).
   */
  private async resolve(path: string, nofollow: boolean): Promise<{ real: string; missing: string[] }> {
    const abs = normalize(path)
    if (abs === '/') return { real: '/', missing: [] }
    if (nofollow) {
      const parent = await this.resolve(dirname(abs), false)
      const full = join(parent.real, basename(abs))
      if (parent.missing.length) return { real: full, missing: [...parent.missing, basename(abs)] }
      return { real: full, missing: (await this.lstat(full)) ? [] : [basename(abs)] }
    }
    const missing: string[] = []
    let head = abs
    for (;;) {
      try {
        const real = await this.fs.realpath(head)
        return { real: missing.length ? join(real, missing.join('/')) : real, missing }
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code !== 'ENOENT' && code !== 'ENOTDIR') throw e
        if (head === '/') return { real: abs, missing }
        missing.unshift(basename(head))
        head = dirname(head)
      }
    }
  }

  /**
   * Throws `EACCES` unless `who` may make the file call. `args` are the call's arguments with paths already absolute.
   * Returns the canonical path a new `open` file handle refers to (so revoking can close it).
   */
  async checkFs(who: Subject, call: string, args: unknown[]): Promise<string | null> {
    if (who.uid === 0 && !who.appId) return null // root outside any app: unrestricted
    const needs = this.needs(call, args)
    let opened: string | null = null
    const scope = who.appId ? this.scope(who.appId) : null
    for (const need of needs) {
      const { real, missing } = await this.resolve(need.path, Boolean(need.nofollow))
      if (scope) this.checkScope(who, scope, call, need, real)
      await this.checkModes(who, call, need, real, missing)
      if (need.op === 'read' || need.op === 'write') opened ??= real
    }
    if (call === 'chmod' || call === 'chown' || call === 'utimes') await this.checkOwner(who, call, args)
    if (call === 'removeAll' && who.uid !== 0) await this.checkTree(who, call, needs[0]!.path)
    return opened
  }

  private deny(who: Subject, call: string, path: string, why: string): never {
    this.audit({ event: 'fs-denied', appId: who.appId, pid: who.pid, call, path, detail: why })
    throw new SysError('EACCES', `${call}: ${why}`, path)
  }

  private checkScope(who: Subject, scope: FsScope, call: string, need: Need, real: string): void {
    const level = this.level(scope, real)
    const ok = need.op === 'search' ? level !== null : need.op === 'read' ? level === 'rw' || level === 'ro' : level === 'rw'
    if (!ok) this.deny(who, call, real, `${who.appId} has no access to this location`)
  }

  private async lstat(path: string): Promise<Stat | null> {
    try {
      return await this.fs.lstat(path)
    } catch {
      return null
    }
  }

  private async checkModes(who: Subject, call: string, need: Need, real: string, missing: string[]): Promise<void> {
    // Search permission on every folder from the root down to the one holding the file.
    const parts = real.split('/').filter(Boolean)
    const folders = ['/']
    for (let i = 1; i < parts.length; i++) folders.push(`/${parts.slice(0, i).join('/')}`)
    for (const dir of folders) {
      const st = await this.lstat(dir)
      if (st && st.kind === 'dir' && !modeAllows(st, who, X)) this.deny(who, call, dir, 'search permission denied')
    }
    if (need.op === 'search') return
    const target = missing.length ? null : await this.lstat(real)
    if (need.op === 'read' || need.op === 'write') {
      if (!target) return // the engine reports ENOENT
      if (!modeAllows(target, who, need.op === 'read' ? R : W)) this.deny(who, call, real, 'permission denied')
      return
    }
    if (need.op === 'create' && target && need.soft) return // writing into a file that exists is checked as `write`
    // create or delete: the folder that holds (or will hold) the name
    const holder = need.op === 'create' && missing.length ? `/${parts.slice(0, parts.length - missing.length).join('/')}` : dirname(real)
    const dirStat = await this.lstat(holder)
    if (!dirStat) return
    if (!modeAllows(dirStat, who, W | X)) this.deny(who, call, holder, 'permission denied')
    if (need.op === 'delete' && target && dirStat.mode & STICKY && who.uid !== 0 && target.uid !== who.uid && dirStat.uid !== who.uid) {
      this.deny(who, call, real, 'sticky folder: only the owner may remove this')
    }
  }

  private async checkOwner(who: Subject, call: string, args: unknown[]): Promise<void> {
    const path = args[0] as string
    const st = await this.lstat((await this.resolve(path, false)).real)
    if (!st) return
    if (call === 'chown') {
      const uid = args[1] as number
      const gid = args[2] as number
      if (who.uid === 0) return
      if (uid >= 0 && uid !== st.uid) this.deny(who, call, path, 'only root can change the owner')
      if (st.uid !== who.uid) this.deny(who, call, path, 'not the owner')
      if (gid >= 0 && gid !== who.gid && !who.groups.includes(gid)) this.deny(who, call, path, 'not a member of that group')
      return
    }
    if (who.uid !== 0 && st.uid !== who.uid && (call === 'chmod' || !modeAllows(st, who, W))) this.deny(who, call, path, 'not the owner')
  }

  /** `removeAll` deletes a whole tree: every folder inside must be writable, as with `rm -r`. */
  private async checkTree(who: Subject, call: string, path: string, seen = { n: 0 }): Promise<void> {
    const { real } = await this.resolve(path, true)
    const st = await this.lstat(real)
    if (!st || st.kind !== 'dir') return
    if (!modeAllows(st, who, W | X | R)) this.deny(who, call, real, 'permission denied')
    for (const e of await this.fs.readdir(real)) {
      if (++seen.n > MAX_TREE_CHECK) this.deny(who, call, real, 'tree too large to check')
      if (e.kind === 'dir') await this.checkTree(who, call, join(real, e.name), seen)
    }
  }

  private needs(call: string, a: unknown[]): Need[] {
    const p = (i: number) => a[i] as string
    switch (call) {
      case 'stat': case 'exists': case 'realpath': case 'getxattr': case 'listxattr': case 'chmod': case 'chown': case 'utimes':
        return [{ path: p(0), op: 'search' }]
      case 'lstat':
        return [{ path: p(0), op: 'search', nofollow: true }]
      case 'readlink':
        return [{ path: p(0), op: 'read', nofollow: true }]
      case 'readdir': case 'readFile':
        return [{ path: p(0), op: 'read' }]
      case 'setxattr': case 'removexattr': case 'truncate':
        return [{ path: p(0), op: 'write' }]
      case 'mkdir':
        return [{ path: p(0), op: 'create', nofollow: true }]
      case 'rmdir': case 'unlink': case 'removeAll': case 'restore':
        return [{ path: p(0), op: 'delete', nofollow: true }]
      case 'symlink':
        return [{ path: p(1), op: 'create', nofollow: true }]
      case 'rename':
        return [{ path: p(0), op: 'delete', nofollow: true }, { path: p(1), op: 'create', nofollow: true }]
      case 'copy':
        return [{ path: p(0), op: 'read' }, { path: p(1), op: 'create', nofollow: true }]
      case 'trash':
        return [{ path: p(0), op: 'delete', nofollow: true }, { path: join(p(1), 'x'), op: 'create' }]
      case 'emptyTrash':
        return [{ path: p(0), op: 'write' }]
      case 'open': {
        const flags = (a[1] as number | undefined) ?? O.RDONLY
        const writes = (flags & 3) !== O.RDONLY || (flags & O.TRUNC) !== 0 || (flags & O.APPEND) !== 0
        const out: Need[] = []
        if (flags & O.CREAT) out.push({ path: p(0), op: 'create', soft: true })
        out.push({ path: p(0), op: writes ? 'write' : 'read' })
        return out
      }
      case 'writeFile': case 'writeFileAtomic':
        return [{ path: p(0), op: 'create', soft: true }, { path: p(0), op: 'write' }]
      default:
        return []
    }
  }

  /** The `search` check for a folder a process wants to work in (chdir, spawn cwd). */
  async checkSearch(who: Subject, path: string): Promise<void> {
    await this.checkFs(who, 'stat', [path])
    if (who.uid === 0 && !who.appId) return
    const { real } = await this.resolve(path, false)
    const st = await this.lstat(real)
    if (st && st.kind === 'dir' && !modeAllows(st, who, X)) this.deny(who, 'chdir', real, 'search permission denied')
  }
}
