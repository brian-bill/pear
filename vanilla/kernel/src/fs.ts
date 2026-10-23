import init, { Vanilla } from '../pkg/tiny_vanilla.js'
import { SysError } from './errors'
import { HostVolume, HOST_FD_BASE, type HostMountOptions } from './hostvol'

type FileType = 'file' | 'dir' | 'symlink'

export interface Stat {
  ino: number
  kind: FileType
  mode: number
  uid: number
  gid: number
  size: number
  nlink: number
  atime: number
  mtime: number
  ctime: number
  birthtime: number
}

export interface DirEntry {
  name: string
  ino: number
  kind: FileType
}

interface Statfs {
  total: number | null
  used: number
  free: number | null
}

/** What mounting had to repair after an unclean shutdown. All zero after a clean one. */
export interface Recovery {
  /** Journal records applied on top of the last full index. */
  replayedRecords: number
  /** Bytes at the end of the journal that were torn or corrupt and dropped. */
  discardedJournalBytes: number
  /** Data blobs with no file (left by a crash), removed. */
  orphanBlobsRemoved: number
  /** Files that were deleted but still open when the last session ended, freed. */
  unlinkedFilesFreed: number
  /** The index came from an older format and was upgraded. */
  upgradedIndex: boolean
}

export interface JournalStats {
  seq: number
  journalBytes: number
  indexBytes: number
  /** Journal records appended since mount. */
  records: number
  /** Full index rewrites since mount. */
  checkpoints: number
}

export interface FsEvent {
  kind: 'created' | 'modified' | 'deleted' | 'renamed'
  path: string
  oldPath: string | null
}

const CHANGE_RING = 20_000

/** Open flags, matching the Rust engine. Combine with `|`. */
export const O = {
  RDONLY: 0,
  WRONLY: 1,
  RDWR: 2,
  CREAT: 0x40,
  EXCL: 0x80,
  TRUNC: 0x200,
  APPEND: 0x400,
  DIRECTORY: 0x10000,
} as const

export const SEEK = { SET: 0, CUR: 1, END: 2 } as const

export interface BootOptions {
  /** OPFS directory name holding this file system. Defaults to `tiny`. */
  namespace?: string
  /** Where to load the Wasm module from. Defaults to next to this script. */
  wasmUrl?: string | URL
}

let wasmReady: Promise<unknown> | undefined

const FLUSH_DELAY_MS = 250
/** A retried operation that still wants handles after this many rounds is stuck. */
const MAX_RETRIES = 64

/**
 * Async interface to the Vanilla file system. Must run inside a Worker, since
 * OPFS synchronous access handles are only available there.
 *
 * Operations are serialized. The engine is synchronous, but may report that it
 * needs OPFS files opened first (`EAGAIN`); this class opens them and retries.
 */
export class FileSystem {
  private chain: Promise<unknown> = Promise.resolve()
  private flushTimer: ReturnType<typeof setTimeout> | undefined

  private constructor(
    private raw: Vanilla,
    private root: FileSystemDirectoryHandle,
    private name: string,
  ) {}

  static async boot(opts: BootOptions = {}): Promise<FileSystem> {
    wasmReady ??= init({ module_or_path: opts.wasmUrl ?? new URL('tiny_vanilla_bg.wasm', import.meta.url) })
    await wasmReady

    const name = opts.namespace ?? 'tiny'
    const root = await navigator.storage.getDirectory()
    const base = await root.getDirectoryHandle(name, { create: true })
    const dataDir = await base.getDirectoryHandle('data', { create: true })
    const metaDir = await base.getDirectoryHandle('meta', { create: true })

    const keys: string[] = []
    for await (const [file] of dataDir.entries()) keys.push(`data/${file}`)
    for await (const [file] of metaDir.entries()) keys.push(`meta/${file}`)

    const fs = new FileSystem(new Vanilla(dataDir, metaDir, keys), root, name)
    await fs.run(() => fs.raw.mount())
    await fs.raw.gc() // delete the files of blobs that mounting found to be orphans
    return fs
  }

  private async settle<T>(fn: () => T): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return fn()
      } catch (e) {
        const err = e as { code?: string; path?: string }
        if (err?.code !== 'EAGAIN' || attempt >= MAX_RETRIES) throw e
        await this.raw.openKeys(String(err.path).split('\n'))
      }
    }
  }

  /** Owner for files created by calls made right now (see `as`). Read when a call is queued, not when it runs. */
  private actor: [number, number] = [0, 0]

  /**
   * Run `call` (which must start its file system calls synchronously) so that files it creates belong to
   * `uid:gid`. Permission checks are not done here: the kernel does them before it calls.
   */
  as<T>(uid: number, gid: number, call: () => T): T {
    const before = this.actor
    this.actor = [uid, gid]
    try {
      return call()
    } finally {
      this.actor = before
    }
  }

  private run<T>(body: () => T): Promise<T> {
    const [uid, gid] = this.actor
    const fn = () => {
      this.raw.setCreds(uid, gid)
      return body()
    }
    const next = this.chain.then(async () => {
      try {
        return await this.settle(fn)
      } catch (e) {
        // Out of space. Files that were removed give their space back only after the removal is journalled
        // and their OPFS files are deleted, which normally happens in the background: do it now, once.
        if ((e as { code?: string })?.code !== 'ENOSPC' || !(await this.reclaim())) throw e
        return this.settle(fn)
      }
    })
    this.chain = next.catch(() => {})
    this.scheduleFlush()
    return next
  }

  /** Journal pending changes and delete the files of removed blobs. True if any space was handed back. */
  private async reclaim(): Promise<boolean> {
    try {
      await this.settle(() => this.raw.flush())
      return (await this.raw.gc()) > 0
    } catch {
      return false
    }
  }

  private scheduleFlush(): void {
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flush().catch((e) => console.error('background flush failed', e))
    }, FLUSH_DELAY_MS)
  }

  async flush(): Promise<void> {
    await this.run(() => this.raw.flush())
    await this.chain
    // gc is async on the wasm side and holds the module's borrow while it runs:
    // queueing it through `run` keeps every other call out until it is done.
    await this.run(() => this.raw.gc())
  }

  /** Flush, release every OPFS handle, and (optionally) delete this namespace. */
  async shutdown(opts: { destroy?: boolean } = {}): Promise<void> {
    clearTimeout(this.flushTimer)
    await this.flush()
    await this.run(() => this.raw.shutdown())
    this.raw.free()
    if (opts.destroy) await this.root.removeEntry(this.name, { recursive: true })
  }

  // ---- metadata

  stat = (path: string) => this.at(path, () => this.run(() => this.raw.stat(path) as Stat), (v, r) => v.stat(r))
  lstat = (path: string) => this.at(path, () => this.run(() => this.raw.lstat(path) as Stat), (v, r) => v.lstat(r))
  exists = (path: string) => this.at(path, () => this.run(() => this.raw.exists(path)), (v, r) => v.exists(r))
  realpath = (path: string) => this.at(path, () => this.run(() => this.raw.realpath(path)), (v, r) => v.realpath(r))
  readdir = (path: string) => this.at(path, () => this.run(() => this.raw.readdir(path) as DirEntry[]), (v, r) => v.readdir(r))
  chmod = (path: string, mode: number) => this.at(path, () => this.run(() => this.raw.chmod(path, mode)), unsupported)
  /** `-1` leaves that field unchanged. */
  chown = (path: string, uid: number, gid: number) => this.at(path, () => this.run(() => this.raw.chown(path, uid, gid)), unsupported)
  utimes = (path: string, atime: number, mtime: number) => this.at(path, () => this.run(() => this.raw.utimes(path, atime, mtime)), unsupported)
  /**
   * File content bytes come from the engine. The total and free space are the browser's quota for this origin
   * (`navigator.storage.estimate()`), since OPFS cannot report them synchronously; without it they are `null`.
   */
  statfs = async (): Promise<Statfs> => {
    const base = await this.run(() => this.raw.statfs() as Statfs)
    try {
      const { quota, usage } = await navigator.storage.estimate()
      if (typeof quota === 'number' && quota > 0) return { total: quota, used: base.used, free: Math.max(0, quota - (usage ?? 0)) }
    } catch {
      // not available: report what the engine knows
    }
    return base
  }

  recovery = () => this.run(() => this.raw.recovery() as Recovery)
  journalStats = () => this.run(() => this.raw.journalStats() as JournalStats)
  checkpoint = () => this.run(() => this.raw.checkpoint())
  setxattr = (path: string, name: string, value: string) => this.at(path, () => this.run(() => this.raw.setxattr(path, name, value)), unsupported)
  getxattr = (path: string, name: string) => this.at(path, () => this.run(() => this.raw.getxattr(path, name) ?? null), async () => null)
  listxattr = (path: string) => this.at(path, () => this.run(() => this.raw.listxattr(path)), async () => [] as string[])
  removexattr = (path: string, name: string) => this.at(path, () => this.run(() => this.raw.removexattr(path, name)), unsupported)
  /**
   * The engine's queue is drained into a numbered ring, so more than one reader can follow the changes: `takeEvents`
   * (Desktop's own cursor) and `changesSince` (system services such as search, each with a cursor of its own).
   */
  private changes: Array<{ seq: number; event: FsEvent }> = []
  private changeSeq = 0
  private takeCursor = 0
  private async drainEngine(): Promise<void> {
    const events = await this.run(() => this.raw.takeEvents() as FsEvent[])
    for (const m of this.mounts.values()) events.push(...m.takeEvents())
    for (const event of events) this.changes.push({ seq: ++this.changeSeq, event })
    if (this.changes.length > CHANGE_RING) this.changes.splice(0, this.changes.length - CHANGE_RING)
  }
  takeEvents = async (): Promise<FsEvent[]> => {
    await this.drainEngine()
    const out = this.changes.filter((c) => c.seq > this.takeCursor).map((c) => c.event)
    this.takeCursor = this.changeSeq
    return out
  }
  /** Changes after `cursor` (0 on first use: from now on). `lost` if the ring has overwritten some, so the reader should rescan. */
  changesSince = async (cursor: number): Promise<{ cursor: number; events: FsEvent[]; lost: boolean }> => {
    await this.drainEngine()
    if (cursor === 0) return { cursor: this.changeSeq, events: [], lost: false }
    const first = this.changes[0]?.seq ?? this.changeSeq + 1
    return { cursor: this.changeSeq, events: this.changes.filter((c) => c.seq > cursor).map((c) => c.event), lost: cursor < first - 1 }
  }

  // ---- namespace

  mkdir = (path: string, opts: { mode?: number; recursive?: boolean } = {}) =>
    this.at(path, () => this.run(() => this.raw.mkdir(path, opts.mode ?? 0o777, opts.recursive ?? false)), (v, r) => v.mkdir(r, opts.recursive ?? false))
  rmdir = (path: string) => this.remove(path, () => this.raw.rmdir(path), (v, r) => v.rmdir(r))
  unlink = (path: string) => this.remove(path, () => this.raw.unlink(path), (v, r) => v.unlink(r))
  removeAll = (path: string) => this.remove(path, () => this.raw.removeAll(path), (v, r) => v.removeAll(r))
  symlink = (target: string, path: string) => this.at(path, () => this.run(() => this.raw.symlink(target, path)), unsupported)
  readlink = (path: string) => this.at(path, () => this.run(() => this.raw.readlink(path)), unsupported)
  rename = (from: string, to: string) => {
    const a = this.mountOf(from)
    const b = this.mountOf(to)
    if (!a && !b) {
      this.busy(from)
      return this.run(() => this.raw.rename(from, to))
    }
    if (a && b && a.vol === b.vol) return a.vol.rename(a.rel, b.rel)
    // across volumes: copy, then remove (what `mv` does between disks)
    if (a && a.rel === '/') return Promise.reject(new SysError('EBUSY', 'a mount point cannot be moved', from))
    this.busy(from)
    return this.crossCopy(from, to, true).then(() => this.removeAll(from))
  }
  copy = (from: string, to: string, opts: { recursive?: boolean } = {}) => {
    const a = this.mountOf(from)
    const b = this.mountOf(to)
    if (!a && !b) return this.run(() => this.raw.copy(from, to, opts.recursive ?? false))
    if (a && b && a.vol === b.vol) return a.vol.copy(a.rel, b.rel, opts.recursive ?? false)
    return this.crossCopy(from, to, opts.recursive ?? false)
  }
  truncate = (path: string, size: number) => this.at(path, () => this.run(() => this.raw.truncate(path, size)), (v, r) => v.truncate(r, size))

  // ---- handles

  open = (path: string, flags: number = O.RDONLY, mode = 0o666) =>
    this.at(path, () => this.run(() => this.raw.open(path, flags, mode)), (v, r) => v.open(r, flags))
  close = async (fd: number) => {
    this.dropLocks(fd)
    return this.onFd(fd, (v) => v.close(fd), () => this.raw.close(fd))
  }
  /** Pass `offset` for a positional read that leaves the handle position alone. */
  read = (fd: number, length: number, offset?: number) => this.onFd(fd, (v) => v.read(fd, length, offset), () => this.raw.read(fd, length, offset))
  write = (fd: number, data: Uint8Array, offset?: number) => this.onFd(fd, (v) => v.write(fd, data, offset), () => this.raw.write(fd, data, offset))
  lseek = (fd: number, offset: number, whence: number = SEEK.SET) => this.onFd(fd, (v) => v.lseek(fd, offset, whence), () => this.raw.lseek(fd, offset, whence))
  fstat = (fd: number) => this.onFd(fd, (v) => v.fstat(fd), () => this.raw.fstat(fd) as Stat)
  ftruncate = (fd: number, size: number) => this.onFd(fd, (v) => v.ftruncate(fd, size), () => this.raw.ftruncate(fd, size))

  // ---- whole files

  readFile = (path: string) => this.at(path, () => this.run(() => this.raw.readFile(path)), (v, r) => v.readFile(r))
  writeFile = (path: string, data: Uint8Array) => this.at(path, () => this.run(() => this.raw.writeFile(path, data)), (v, r) => v.writeFile(r, data))
  writeFileAtomic = (path: string, data: Uint8Array) =>
    this.at(path, () => this.run(() => this.raw.writeFileAtomic(path, data)), (v, r) => v.writeFileAtomic(r, data))

  // ---- trash

  trash = (path: string, trashDir: string) =>
    this.mountOf(path) || this.mountOf(trashDir)
      ? Promise.reject(new SysError('ENOSYS', 'the trash does not work on host volumes: delete the file instead', path))
      : (this.busy(path), this.run(() => this.raw.trash(path, trashDir)))
  restore = (path: string) => this.run(() => this.raw.restore(path))
  emptyTrash = (trashDir: string) => this.run(() => this.raw.emptyTrash(trashDir))

  // ---- host volumes

  private mounts = new Map<string, HostVolume>()

  /** The volume holding `path` and the path inside it (`/` for the mount point itself); null for the VFS. */
  private mountOf(path: string): { vol: HostVolume; rel: string } | null {
    if (!this.mounts.size) return null
    const p = cleanPath(path)
    for (const [point, vol] of this.mounts) {
      if (p === point) return { vol, rel: '/' }
      if (p.startsWith(`${point}/`)) return { vol, rel: p.slice(point.length) }
    }
    return null
  }

  private at<T>(path: string, local: () => Promise<T>, remote: (vol: HostVolume, rel: string) => Promise<T>): Promise<T> {
    const m = this.mountOf(path)
    if (!m) return local()
    return remote(m.vol, m.rel).catch((e) => {
      throw e instanceof SysError && !e.path ? new SysError(e.code, e.message, path) : e
    })
  }

  /** Removing or moving something that is, or holds, a mount point is refused. */
  private busy(path: string): void {
    if (!this.mounts.size) return
    const p = cleanPath(path)
    for (const point of this.mounts.keys()) {
      if (point === p || point.startsWith(p === '/' ? '/' : `${p}/`)) throw new SysError('EBUSY', 'a volume is mounted here: unmount it first', path)
    }
  }

  private remove(path: string, local: () => void, remote: (vol: HostVolume, rel: string) => Promise<void>): Promise<void> {
    return this.at(path, () => (this.busy(path), this.run(local)), (v, r) => (r === '/' ? mountPointBusy(path) : remote(v, r)))
  }

  private onFd<T>(fd: number, remote: (vol: HostVolume) => Promise<T>, local: () => T): Promise<T> {
    const vol = this.volumeOfFd(fd)
    return vol ? remote(vol) : this.run(local)
  }

  private volumeOfFd(fd: number): HostVolume | null {
    if (fd < HOST_FD_BASE) return null
    for (const v of this.mounts.values()) if (v.owns(fd)) return v
    throw new SysError('EBADF')
  }

  /**
   * Show a host folder at `point` (a folder in the VFS that is empty, or does not exist yet). Files below it
   * belong to `opts.uid`/`gid`; with `readOnly` nothing can be changed. Not persisted: mount again after a reload.
   */
  async mount(handle: FileSystemDirectoryHandle, point: string, opts: HostMountOptions = {}): Promise<void> {
    if (typeof point !== 'string' || !point.startsWith('/')) throw new SysError('EINVAL', 'mount point must be an absolute path')
    const at = cleanPath(point)
    if (at === '/') throw new SysError('EINVAL', 'cannot mount over the root')
    if (!handle || handle.kind !== 'directory') throw new SysError('EINVAL', 'mount needs a directory handle')
    for (const other of this.mounts.keys()) {
      if (other === at || at.startsWith(`${other}/`) || other.startsWith(`${at}/`)) throw new SysError('EBUSY', `${other} is already a mount point`, at)
    }
    let st: Stat | null = null
    try {
      st = await this.lstat(at)
    } catch (e) {
      if ((e as { code?: string }).code !== 'ENOENT') throw e
    }
    if (st && st.kind !== 'dir') throw new SysError('ENOTDIR', undefined, at)
    if (st && (await this.readdir(at)).length) throw new SysError('ENOTEMPTY', 'the mount point must be an empty folder', at)
    const vol = new HostVolume(handle, at, opts)
    await vol.probe()
    if (!st) await this.mkdir(at, { recursive: true })
    this.mounts.set(at, vol)
  }

  /** `EBUSY` while files on it are open, unless `force` (they are written back and closed). */
  async unmount(point: string, opts: { force?: boolean } = {}): Promise<void> {
    const at = cleanPath(point)
    const vol = this.mounts.get(at)
    if (!vol) throw new SysError('EINVAL', 'nothing is mounted there', point)
    if (vol.openFiles().length && !opts.force) throw new SysError('EBUSY', 'files on this volume are open', point)
    for (const f of vol.openFiles()) this.dropLocks(f.fd)
    await vol.closeAll()
    this.mounts.delete(at)
  }

  mountPoints = (): Array<{ point: string; readOnly: boolean; name: string; open: number }> =>
    [...this.mounts].map(([point, v]) => ({ point, readOnly: v.readOnly, name: v.handle.name, open: v.openFiles().length }))

  /** Copy between volumes (or from one into another) by reading and writing. Files and folders only. */
  private async crossCopy(from: string, to: string, recursive: boolean): Promise<void> {
    const [uid, gid] = this.actor
    const as = <T>(call: () => Promise<T>) => this.as(uid, gid, call)
    const copy = async (src: string, dst: string): Promise<void> => {
      const st = await this.lstat(src)
      if (st.kind === 'symlink') throw new SysError('ENOSYS', 'symbolic links cannot be copied to a host volume', src)
      if (await this.exists(dst)) throw new SysError('EEXIST', undefined, dst)
      if (st.kind === 'dir') {
        if (!recursive) throw new SysError('EISDIR', 'copying a folder needs recursive', src)
        if (dst.startsWith(`${src}/`)) throw new SysError('EINVAL', 'cannot copy a folder into itself', src)
        await as(() => this.mkdir(dst))
        for (const e of await this.readdir(src)) await copy(`${src}/${e.name}`, `${dst}/${e.name}`)
        return
      }
      await as(() => this.writeFile(dst, new Uint8Array(0)))
      const data = await this.readFile(src)
      await as(() => this.writeFile(dst, data))
      if (!this.mountOf(dst)) await this.chmod(dst, st.mode)
    }
    try {
      await copy(cleanPath(from), cleanPath(to))
    } catch (e) {
      await this.removeAll(to).catch(() => {}) // like a failed copy within the volume: no partial result
      throw e
    }
  }

  // ---- advisory locks

  private lockTable = new Map<string, LockState>()
  private lockOf = new Map<number, string>()

  /**
   * Advisory lock on the open file `fd`: `sh` (many may hold it), `ex` (one holder), or `un` (let go). It affects
   * only others that also call `flock`; a lock is dropped when its descriptor is closed (so when its process ends).
   * Locks belong to descriptors, so two opens of one file in the same process conflict. Changing `sh` to `ex` on
   * the same descriptor succeeds at once when nobody else holds the file, and otherwise waits with the `sh` lock
   * kept. `nonblock` fails with `EAGAIN` instead of waiting; `timeout` (ms) fails with `ETIMEDOUT`.
   */
  async flock(fd: number, op: 'sh' | 'ex' | 'un', opts: { nonblock?: boolean; timeout?: number } = {}): Promise<void> {
    if (op !== 'sh' && op !== 'ex' && op !== 'un') throw new SysError('EINVAL', 'lock operation must be sh, ex or un')
    const st = await this.fstat(fd) // EBADF if it is not open
    const key = `${st.ino}:${fd >= HOST_FD_BASE ? [...this.mounts].find(([, v]) => v.owns(fd))?.[0] ?? '' : ''}`
    if (op === 'un') {
      this.dropLocks(fd)
      return
    }
    let state = this.lockTable.get(key)
    if (!state) this.lockTable.set(key, (state = { holders: new Map(), waiters: [] }))
    const holding = state.holders.get(fd)
    if (holding === op) return
    if (canGrant(state, fd, op) && (holding || !state.waiters.length)) {
      state.holders.set(fd, op)
      this.lockOf.set(fd, key)
      return
    }
    if (opts.nonblock) throw new SysError('EAGAIN', 'the file is locked')
    await new Promise<void>((resolve, reject) => {
      const w: Waiter = { fd, type: op, resolve, reject, timer: undefined }
      if (opts.timeout !== undefined) {
        w.timer = setTimeout(() => {
          state!.waiters = state!.waiters.filter((x) => x !== w)
          reject(new SysError('ETIMEDOUT', 'timed out waiting for the lock'))
          this.pump(key)
        }, opts.timeout)
      }
      state!.waiters.push(w)
    })
  }

  /** Release what `fd` holds and fail what it waits for. */
  private dropLocks(fd: number): void {
    const key = this.lockOf.get(fd)
    if (key !== undefined) return this.release(key, fd)
    // not holding anything, maybe only waiting
    for (const [k, st] of this.lockTable) if (st.waiters.some((w) => w.fd === fd)) this.release(k, fd)
  }
  private release(key: string, fd: number): void {
    const state = this.lockTable.get(key)
    if (!state) return
    state.holders.delete(fd)
    this.lockOf.delete(fd)
    for (const w of state.waiters.filter((x) => x.fd === fd)) {
      clearTimeout(w.timer)
      w.reject(new SysError('EBADF', 'the descriptor was closed while waiting for the lock'))
    }
    state.waiters = state.waiters.filter((x) => x.fd !== fd)
    this.pump(key)
  }
  private pump(key: string): void {
    const state = this.lockTable.get(key)
    if (!state) return
    while (state.waiters.length && canGrant(state, state.waiters[0]!.fd, state.waiters[0]!.type)) {
      const w = state.waiters.shift()!
      clearTimeout(w.timer)
      state.holders.set(w.fd, w.type)
      this.lockOf.set(w.fd, key)
      w.resolve()
    }
    if (!state.holders.size && !state.waiters.length) this.lockTable.delete(key)
  }

  // ---- bookmarks

  private bookmarks: Record<string, string> | null = null

  private async loadBookmarks(): Promise<Record<string, string>> {
    if (this.bookmarks) return this.bookmarks
    try {
      const doc = JSON.parse(new TextDecoder().decode(await this.readFile(BOOKMARK_FILE))) as { items?: Record<string, string> }
      this.bookmarks = doc.items && typeof doc.items === 'object' ? doc.items : {}
    } catch {
      this.bookmarks = {}
    }
    return this.bookmarks
  }
  private async saveBookmarks(): Promise<void> {
    await this.mkdir('/var/db', { recursive: true }).catch(() => {})
    await this.writeFileAtomic(BOOKMARK_FILE, new TextEncoder().encode(JSON.stringify({ version: 1, items: this.bookmarks })))
  }
  private async idsOn(path: string): Promise<string[]> {
    const v = await this.getxattr(path, BOOKMARK_XATTR)
    return v ? v.split(',').filter(Boolean) : []
  }

  /**
   * A stable reference to a file or folder: `resolveBookmark(id)` finds it again after it was renamed or moved
   * (the id is stored in the file's extended attributes, so it also survives a disk image restore). Copies keep
   * the id too: resolving prefers the place it was last seen, so the original is found unless it is gone.
   */
  async bookmark(path: string): Promise<string> {
    if (this.mountOf(path)) throw new SysError('ENOSYS', 'bookmarks need extended attributes, which host volumes do not have', path)
    const real = await this.realpath(path)
    const table = await this.loadBookmarks()
    const ids = await this.idsOn(real)
    const existing = ids.find((id) => id in table)
    if (existing) {
      table[existing] = real
      await this.saveBookmarks()
      return existing
    }
    const id = crypto.randomUUID()
    await this.setxattr(real, BOOKMARK_XATTR, [...ids, id].join(','))
    table[id] = real
    await this.saveBookmarks()
    return id
  }

  /** The path a bookmark points to now. `ENOENT` if the file is gone. */
  async resolveBookmark(id: string): Promise<string> {
    const table = await this.loadBookmarks()
    const last = table[id]
    if (last === undefined) throw new SysError('ENOENT', 'no such bookmark')
    const found = (await this.hasId(last, id)) ? last : await this.search('/', id)
    if (found === null) throw new SysError('ENOENT', 'the bookmarked file no longer exists', last)
    if (found !== last) {
      table[id] = found
      await this.saveBookmarks()
    }
    return found
  }

  async removeBookmark(id: string): Promise<void> {
    const table = await this.loadBookmarks()
    const last = table[id]
    if (last === undefined) return
    delete table[id]
    const at = (await this.hasId(last, id)) ? last : await this.search('/', id)
    if (at !== null) {
      const rest = (await this.idsOn(at)).filter((x) => x !== id)
      if (rest.length) await this.setxattr(at, BOOKMARK_XATTR, rest.join(','))
      else await this.removexattr(at, BOOKMARK_XATTR)
    }
    await this.saveBookmarks()
  }

  async listBookmarks(): Promise<Array<{ id: string; path: string }>> {
    return Object.entries(await this.loadBookmarks()).map(([id, path]) => ({ id, path }))
  }

  private async hasId(path: string, id: string): Promise<boolean> {
    try {
      return (await this.idsOn(path)).includes(id)
    } catch {
      return false
    }
  }
  private async search(dir: string, id: string): Promise<string | null> {
    let entries: DirEntry[]
    try {
      entries = await this.readdir(dir)
    } catch {
      return null
    }
    for (const e of entries) {
      if (e.kind === 'symlink') continue
      const path = dir === '/' ? `/${e.name}` : `${dir}/${e.name}`
      if (this.mounts.has(path)) continue
      if (await this.hasId(path, id)) return path
      if (e.kind === 'dir') {
        const hit = await this.search(path, id)
        if (hit) return hit
      }
    }
    return null
  }
}

const BOOKMARK_FILE = '/var/db/bookmarks.json'
const BOOKMARK_XATTR = 'com.tiny.bookmark'

interface Waiter {
  fd: number
  type: 'sh' | 'ex'
  resolve: () => void
  reject: (e: Error) => void
  timer: ReturnType<typeof setTimeout> | undefined
}
interface LockState {
  holders: Map<number, 'sh' | 'ex'>
  waiters: Waiter[]
}

function canGrant(state: LockState, fd: number, type: 'sh' | 'ex'): boolean {
  for (const [other, t] of state.holders) {
    if (other === fd) continue
    if (type === 'ex' || t === 'ex') return false
  }
  return true
}

const mountPointBusy = (path: string): Promise<never> => Promise.reject(new SysError('EBUSY', 'a volume is mounted here: unmount it first', path))
const unsupported = (): Promise<never> => Promise.reject(new SysError('ENOSYS', 'not supported on host volumes'))

/** Collapse `.`, `..` and repeated slashes so that mount points are matched on the path the engine would see. */
function cleanPath(path: string): string {
  if (!/\/\.\.?(\/|$)|\/\/|.\/$/.test(path)) return path
  const out: string[] = []
  for (const part of path.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

/** Methods the kernel Worker exposes over RPC. */
export const FS_METHODS = [
  'flush', 'stat', 'lstat', 'exists', 'realpath', 'readdir', 'chmod', 'chown', 'utimes', 'statfs',
  'setxattr', 'getxattr', 'listxattr', 'removexattr', 'takeEvents',
  'mkdir', 'rmdir', 'unlink', 'removeAll', 'symlink', 'readlink', 'rename', 'copy', 'truncate',
  'open', 'close', 'read', 'write', 'lseek', 'fstat', 'ftruncate',
  'readFile', 'writeFile', 'writeFileAtomic', 'trash', 'restore', 'emptyTrash', 'flock',
] as const satisfies readonly (keyof FileSystem)[]

export type FsMethod = (typeof FS_METHODS)[number]
