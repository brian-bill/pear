/// A host directory (File System Access API, or any `FileSystemDirectoryHandle`) shown inside the VFS as a mounted
/// volume. The kernel routes calls for paths below the mount point here (`FileSystem.mount`).
///
/// What is different from the VFS volume: no symlinks, owners, xattrs or trash (`ENOSYS`); every entry has the
/// mount's owner and a mode derived from `readOnly`; inode numbers are made up and last only until the volume is
/// unmounted; an open file is held in memory and written back when it is closed or synced (`ftruncate`, `write`
/// then `close`), so very large files cost memory.
import { SysError } from './errors'
import type { DirEntry, FsEvent, Stat } from './fs'
import { O, SEEK } from './fs'

export interface HostMountOptions {
  readOnly?: boolean
  uid?: number
  gid?: number
}

/** Descriptors of host files live far above engine and pipe descriptors. */
export const HOST_FD_BASE = 1 << 28

const NAME_MAX = 255

interface OpenFile {
  rel: string
  handle: FileSystemFileHandle
  data: Uint8Array
  pos: number
  flags: number
  dirty: boolean
}

function mapError(e: unknown, path?: string): never {
  if (e instanceof SysError) throw e
  const name = errName(e)
  const code =
    name === 'NotFoundError' ? 'ENOENT'
      : name === 'TypeMismatchError' ? 'ENOTDIR'
        : name === 'NotAllowedError' || name === 'SecurityError' ? 'EACCES'
          : name === 'InvalidModificationError' ? 'ENOTEMPTY'
            : name === 'QuotaExceededError' ? 'ENOSPC'
              : name === 'NoModificationAllowedError' ? 'EBUSY'
                : name === 'TypeError' ? 'EINVAL'
                  : 'EIO'
  throw new SysError(code, (e as Error)?.message ?? undefined, path)
}

const split = (rel: string) => rel.split('/').filter(Boolean)
const errName = (e: unknown) => (e as { name?: string } | undefined)?.name
const bytesOf = async (h: FileSystemFileHandle) => new Uint8Array(await (await h.getFile()).arrayBuffer())
const resized = (data: Uint8Array, size: number) => {
  const next = new Uint8Array(size)
  next.set(data.subarray(0, Math.min(size, data.length)))
  return next
}

export class HostVolume {
  readonly readOnly: boolean
  private uid: number
  private gid: number
  private inos = new Map<string, number>()
  private nextIno = 2 ** 40
  private fds = new Map<number, OpenFile>()
  private nextFd = HOST_FD_BASE
  private queue: FsEvent[] = []

  constructor(
    readonly handle: FileSystemDirectoryHandle,
    /** Where it is mounted in the VFS (used for event paths). */
    readonly point: string,
    opts: HostMountOptions = {},
  ) {
    this.readOnly = opts.readOnly ?? false
    this.uid = opts.uid ?? 0
    this.gid = opts.gid ?? 0
  }

  async probe(): Promise<void> {
    try {
      const h = this.handle as FileSystemDirectoryHandle & { queryPermission?: (d: { mode: string }) => Promise<string> }
      const state = await h.queryPermission?.({ mode: this.readOnly ? 'read' : 'readwrite' })
      if (state && state !== 'granted') throw new SysError('EACCES', `access to the host folder is ${state}: ask the user again`)
      for await (const _ of this.handle.keys()) break
    } catch (e) {
      mapError(e, this.point)
    }
  }

  takeEvents(): FsEvent[] {
    const out = this.queue
    this.queue = []
    return out
  }
  private emit(kind: FsEvent['kind'], rel: string, oldRel: string | null = null): void {
    if (this.queue.length < 4096) this.queue.push({ kind, path: this.abs(rel), oldPath: oldRel === null ? null : this.abs(oldRel) })
  }
  private abs(rel: string): string {
    return rel === '/' ? this.point : `${this.point}${rel}`
  }
  private writable(): void {
    if (this.readOnly) throw new SysError('EROFS', 'this volume is read-only', this.point)
  }
  private ino(rel: string): number {
    let n = this.inos.get(rel)
    if (n === undefined) this.inos.set(rel, (n = this.nextIno++))
    return n
  }

  // ---- lookup

  private async dirAt(parts: string[]): Promise<FileSystemDirectoryHandle> {
    let dir = this.handle
    for (const p of parts) {
      try {
        dir = await dir.getDirectoryHandle(p)
      } catch (e) {
        if (errName(e) === 'TypeMismatchError') throw new SysError('ENOTDIR')
        throw e
      }
    }
    return dir
  }

  private async find(rel: string): Promise<{ kind: 'file'; handle: FileSystemFileHandle } | { kind: 'dir'; handle: FileSystemDirectoryHandle }> {
    const parts = split(rel)
    if (!parts.length) return { kind: 'dir', handle: this.handle }
    const name = parts.pop()!
    const dir = await this.dirAt(parts)
    try {
      return { kind: 'file', handle: await dir.getFileHandle(name) }
    } catch (e) {
      if (errName(e) !== 'TypeMismatchError') throw e
    }
    return { kind: 'dir', handle: await dir.getDirectoryHandle(name) }
  }

  private checkName(name: string): void {
    if (!name || name.length > NAME_MAX || name.includes('\0') || name.includes('\\')) throw new SysError('EINVAL', 'invalid file name', name)
  }

  private async guard<T>(rel: string, body: () => Promise<T>): Promise<T> {
    try {
      return await body()
    } catch (e) {
      return mapError(e, this.abs(rel))
    }
  }

  private statOf(rel: string, kind: 'file' | 'dir', size: number, mtime: number): Stat {
    const mode = kind === 'dir' ? (this.readOnly ? 0o555 : 0o755) : this.readOnly ? 0o444 : 0o644
    return { ino: this.ino(rel), kind, mode, uid: this.uid, gid: this.gid, size, nlink: 1, atime: mtime, mtime, ctime: mtime, birthtime: mtime }
  }

  // ---- metadata

  stat = (rel: string): Promise<Stat> =>
    this.guard(rel, async () => {
      const e = await this.find(rel)
      if (e.kind === 'dir') return this.statOf(rel, 'dir', 0, 0)
      const f = await e.handle.getFile()
      const open = [...this.fds.values()].find((o) => o.rel === rel)
      return this.statOf(rel, 'file', open ? open.data.length : f.size, f.lastModified)
    })
  lstat = this.stat
  exists = async (rel: string): Promise<boolean> => {
    try {
      await this.find(rel)
      return true
    } catch (e) {
      const code = errName(e) === 'NotFoundError' || (e as { code?: string }).code === 'ENOTDIR'
      if (code) return false
      return mapError(e, this.abs(rel))
    }
  }
  realpath = async (rel: string): Promise<string> => {
    await this.stat(rel)
    return this.abs(rel)
  }
  readdir = (rel: string): Promise<DirEntry[]> =>
    this.guard(rel, async () => {
      const e = await this.find(rel)
      if (e.kind !== 'dir') throw new SysError('ENOTDIR', undefined, this.abs(rel))
      const out: DirEntry[] = []
      for await (const [name, h] of e.handle.entries()) {
        out.push({ name, ino: this.ino(rel === '/' ? `/${name}` : `${rel}/${name}`), kind: h.kind === 'directory' ? 'dir' : 'file' })
      }
      return out.sort((a, b) => (a.name < b.name ? -1 : 1))
    })

  // ---- namespace

  mkdir = (rel: string, recursive: boolean): Promise<void> =>
    this.guard(rel, async () => {
      this.writable()
      const parts = split(rel)
      if (!parts.length) throw new SysError('EEXIST')
      let dir = this.handle
      for (let i = 0; i < parts.length; i++) {
        const name = parts[i]!
        this.checkName(name)
        const last = i === parts.length - 1
        let child: FileSystemDirectoryHandle | null = null
        try {
          child = await dir.getDirectoryHandle(name)
        } catch (e) {
          const n = errName(e)
          if (n === 'TypeMismatchError') throw new SysError(last ? 'EEXIST' : 'ENOTDIR')
          if (n !== 'NotFoundError') throw e
        }
        if (child) {
          if (last && !recursive) throw new SysError('EEXIST')
          dir = child
          continue
        }
        if (!last && !recursive) throw new SysError('ENOENT')
        dir = await dir.getDirectoryHandle(name, { create: true })
        this.emit('created', `/${parts.slice(0, i + 1).join('/')}`)
      }
    })

  rmdir = (rel: string): Promise<void> =>
    this.guard(rel, async () => {
      this.writable()
      const e = await this.find(rel)
      if (e.kind !== 'dir') throw new SysError('ENOTDIR')
      await this.removeEntry(rel, false)
    })
  unlink = (rel: string): Promise<void> =>
    this.guard(rel, async () => {
      this.writable()
      const e = await this.find(rel)
      if (e.kind === 'dir') throw new SysError('EISDIR')
      await this.removeEntry(rel, false)
    })
  removeAll = (rel: string): Promise<void> =>
    this.guard(rel, async () => {
      this.writable()
      await this.find(rel)
      await this.removeEntry(rel, true)
    })
  private async removeEntry(rel: string, recursive: boolean): Promise<void> {
    const parts = split(rel)
    const name = parts.pop()
    if (name === undefined) throw new SysError('EBUSY', 'the root of a volume cannot be removed')
    const dir = await this.dirAt(parts)
    await dir.removeEntry(name, { recursive })
    for (const k of [...this.inos.keys()]) if (k === rel || k.startsWith(`${rel}/`)) this.inos.delete(k)
    this.emit('deleted', rel)
  }

  /** Copy within the volume. Files and folders only. */
  copy = (from: string, to: string, recursive: boolean): Promise<void> =>
    this.guard(to, async () => {
      this.writable()
      const src = await this.find(from)
      if (src.kind === 'dir' && !recursive) throw new SysError('EISDIR', 'copying a folder needs recursive')
      if (to === from || to.startsWith(`${from}/`)) throw new SysError('EINVAL', 'cannot copy a folder into itself')
      if (await this.exists(to)) throw new SysError('EEXIST', undefined, this.abs(to))
      await this.copyTree(from, src, to)
    })
  private async copyTree(from: string, src: { kind: 'file'; handle: FileSystemFileHandle } | { kind: 'dir'; handle: FileSystemDirectoryHandle }, to: string): Promise<void> {
    if (src.kind === 'file') {
      await this.putFile(to, await bytesOf(src.handle))
      return
    }
    await this.mkdir(to, false)
    for await (const [name, h] of src.handle.entries()) {
      await this.copyTree(`${from}/${name}`, h.kind === 'directory' ? { kind: 'dir', handle: h as FileSystemDirectoryHandle } : { kind: 'file', handle: h as FileSystemFileHandle }, `${to}/${name}`)
    }
  }

  /** Rename within the volume: a copy and a delete (host handles cannot move reliably). */
  rename = (from: string, to: string): Promise<void> =>
    this.guard(from, async () => {
      this.writable()
      if (from === to) return
      if (to.startsWith(`${from}/`)) throw new SysError('EINVAL', 'cannot move a folder into itself')
      const src = await this.find(from)
      const dst = await this.find(to).catch((e) => (errName(e) === 'NotFoundError' ? null : Promise.reject(e)))
      if (dst) {
        if (dst.kind === 'dir' && src.kind !== 'dir') throw new SysError('EISDIR')
        if (dst.kind !== 'dir' && src.kind === 'dir') throw new SysError('ENOTDIR')
        if (dst.kind === 'dir') {
          for await (const _ of dst.handle.keys()) throw new SysError('ENOTEMPTY')
        }
        await this.removeEntry(to, true)
      }
      await this.copyTree(from, src, to)
      await this.removeEntry(from, true)
      this.emit('renamed', to, from)
    })

  // ---- whole files

  readFile = (rel: string): Promise<Uint8Array> =>
    this.guard(rel, async () => {
      const open = [...this.fds.values()].find((o) => o.rel === rel && o.dirty)
      if (open) return open.data.slice()
      const e = await this.find(rel)
      if (e.kind === 'dir') throw new SysError('EISDIR')
      return bytesOf(e.handle)
    })

  private async putFile(rel: string, data: Uint8Array): Promise<boolean> {
    const parts = split(rel)
    const name = parts.pop()
    if (name === undefined) throw new SysError('EISDIR')
    this.checkName(name)
    const dir = await this.dirAt(parts)
    let existed = true
    try {
      await dir.getFileHandle(name)
    } catch (e) {
      if (errName(e) === 'TypeMismatchError') throw new SysError('EISDIR')
      existed = false
    }
    const file = await dir.getFileHandle(name, { create: true })
    // `createWritable` keeps a swap file and replaces the real one when it is closed, so this is atomic
    const w = await (file as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable()
    await w.write(data as unknown as BufferSource)
    await w.close()
    return existed
  }
  writeFile = (rel: string, data: Uint8Array): Promise<void> =>
    this.guard(rel, async () => {
      this.writable()
      const existed = await this.putFile(rel, data)
      this.emit(existed ? 'modified' : 'created', rel)
    })
  writeFileAtomic = this.writeFile
  truncate = (rel: string, size: number): Promise<void> =>
    this.guard(rel, async () => {
      this.writable()
      const e = await this.find(rel)
      if (e.kind === 'dir') throw new SysError('EISDIR')
      await this.putFile(rel, resized(await bytesOf(e.handle), size))
      this.emit('modified', rel)
    })

  // ---- handles

  open = (rel: string, flags: number): Promise<number> =>
    this.guard(rel, async () => {
      const mode = flags & 3
      const writes = mode !== O.RDONLY || (flags & (O.TRUNC | O.APPEND)) !== 0
      if (writes || flags & O.CREAT) this.writable()
      if (this.fds.size >= 256) throw new SysError('EMFILE')
      let data = new Uint8Array(0)
      let handle: FileSystemFileHandle
      let dirty = false
      let found: Awaited<ReturnType<HostVolume['find']>> | null = null
      try {
        found = await this.find(rel)
      } catch (e) {
        if (errName(e) !== 'NotFoundError') throw e
      }
      if (found?.kind === 'dir') {
        throw new SysError('EISDIR', writes ? undefined : 'directories are read with readdir')
      }
      if (flags & O.DIRECTORY) throw new SysError('ENOTDIR')
      if (found) {
        if (flags & O.CREAT && flags & O.EXCL) throw new SysError('EEXIST')
        handle = found.handle
        if (flags & O.TRUNC) dirty = true
        else data = await bytesOf(handle)
      } else {
        if (!(flags & O.CREAT)) throw new SysError('ENOENT')
        await this.putFile(rel, data)
        this.emit('created', rel)
        handle = (await this.find(rel)).handle as FileSystemFileHandle
      }
      const fd = this.nextFd++
      this.fds.set(fd, { rel, handle, data, pos: 0, flags, dirty })
      return fd
    })

  private file(fd: number): OpenFile {
    const f = this.fds.get(fd)
    if (!f) throw new SysError('EBADF')
    return f
  }
  owns = (fd: number): boolean => this.fds.has(fd)
  openFiles(): Array<{ fd: number; rel: string }> {
    return [...this.fds].map(([fd, f]) => ({ fd, rel: f.rel }))
  }

  private async flushFile(f: OpenFile): Promise<void> {
    if (!f.dirty) return
    await this.guard(f.rel, () => this.putFile(f.rel, f.data))
    f.dirty = false
    this.emit('modified', f.rel)
  }
  close = async (fd: number): Promise<void> => {
    const f = this.file(fd)
    try {
      await this.flushFile(f)
    } finally {
      this.fds.delete(fd)
    }
  }
  async sync(): Promise<void> {
    for (const f of this.fds.values()) await this.flushFile(f)
  }
  read = async (fd: number, length: number, offset?: number): Promise<Uint8Array> => {
    const f = this.file(fd)
    if ((f.flags & 3) === O.WRONLY) throw new SysError('EBADF', 'not open for reading')
    const at = offset ?? f.pos
    const out = f.data.slice(at, at + length)
    if (offset === undefined) f.pos += out.length
    return out
  }
  write = async (fd: number, data: Uint8Array, offset?: number): Promise<number> => {
    const f = this.file(fd)
    if ((f.flags & 3) === O.RDONLY) throw new SysError('EBADF', 'not open for writing')
    const at = f.flags & O.APPEND ? f.data.length : (offset ?? f.pos)
    if (at + data.length > f.data.length) {
      const bigger = new Uint8Array(at + data.length)
      bigger.set(f.data)
      f.data = bigger
    }
    f.data.set(data, at)
    f.dirty = true
    if (offset === undefined || f.flags & O.APPEND) f.pos = at + data.length
    return data.length
  }
  lseek = async (fd: number, offset: number, whence: number): Promise<number> => {
    const f = this.file(fd)
    if (whence !== SEEK.SET && whence !== SEEK.CUR && whence !== SEEK.END) throw new SysError('EINVAL')
    const base = whence === SEEK.SET ? 0 : whence === SEEK.CUR ? f.pos : f.data.length
    if (base + offset < 0) throw new SysError('EINVAL')
    return (f.pos = base + offset)
  }
  fstat = async (fd: number): Promise<Stat> => {
    const f = this.file(fd)
    const file = await f.handle.getFile()
    return this.statOf(f.rel, 'file', f.data.length, f.dirty ? Date.now() : file.lastModified)
  }
  ftruncate = async (fd: number, size: number): Promise<void> => {
    const f = this.file(fd)
    if ((f.flags & 3) === O.RDONLY) throw new SysError('EBADF', 'not open for writing')
    f.data = resized(f.data, size)
    f.dirty = true
  }

  async closeAll(): Promise<void> {
    for (const fd of [...this.fds.keys()]) await this.close(fd).catch(() => {})
  }
}
