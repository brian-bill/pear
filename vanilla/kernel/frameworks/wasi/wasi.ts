/// The WASI framework: the `wasi_snapshot_preview1` system interface over
/// Vanilla's files, standard streams and clocks, shared by every WebAssembly runtime. A runtime's launcher loads this
/// module, builds `imports` for its `.wasm`, and runs it:
///
///   const { createWasi, hostFromTiny } = await import(blobUrlOfWasiJs)
///   const wasi = createWasi({ host: hostFromTiny(tiny), args: [...], env, preopens: { '/': cwd } })
///   const { instance } = await WebAssembly.instantiate(bytes, wasi.imports)
///   return wasi.start(instance)                       // the program's exit code
///
/// WASI calls are synchronous and Vanilla's are not. Every import here is an `async` function: with JSPI
/// (`WebAssembly.Suspending`, Chrome and Edge 137+) they are wrapped so the program suspends while the host answers; for
/// a module transformed with Asyncify the runtime's own glue awaits them (`suspend: false`). It is not a trust
/// boundary: it runs in the program's process and can do only what that process can.
///
/// Not provided: sockets (`sock_*` are `ENOSYS`), hard links, file locks, threads. A guest sees only its preopened
/// folders; `..` cannot leave one (`ENOTCAPABLE`).

// ---- WASI constants (preview1)
const E = {
  SUCCESS: 0, TOOBIG: 1, ACCES: 2, AGAIN: 6, BADF: 8, BUSY: 10, CANCELED: 11, EXIST: 20, FBIG: 22, INTR: 27, INVAL: 28, IO: 29, ISDIR: 31, LOOP: 32,
  MFILE: 33, NAMETOOLONG: 37, NOENT: 44, NOMEM: 48, NOSPC: 51, NOSYS: 52, NOTDIR: 54, NOTEMPTY: 55, NOTSUP: 58, NOTTY: 59, PERM: 63, PIPE: 64,
  ROFS: 69, SPIPE: 70, SRCH: 71, TIMEDOUT: 73, XDEV: 75, NOTCAPABLE: 76,
} as const
const TYPE = { UNKNOWN: 0, CHAR: 2, DIR: 3, FILE: 4, SYMLINK: 7 } as const
const OFLAGS = { CREAT: 1, DIRECTORY: 2, EXCL: 4, TRUNC: 8 }
const FDFLAGS_APPEND = 1
const RIGHT_READ = 1n << 1n
const RIGHT_WRITE = 1n << 6n
const ALL_RIGHTS = 0x1fffffffn
const FST = { ATIM: 1, ATIM_NOW: 2, MTIM: 4, MTIM_NOW: 8 }
const HOST_O = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, TRUNC: 0x200, APPEND: 0x400 }

const ERRNO_OF: Record<string, number> = {
  E2BIG: E.TOOBIG, EACCES: E.ACCES, EAGAIN: E.AGAIN, EBADF: E.BADF, EBUSY: E.BUSY, ECANCELED: E.CANCELED, EEXIST: E.EXIST, EINTR: E.INTR,
  EINVAL: E.INVAL, EIO: E.IO, EISDIR: E.ISDIR, EMFILE: E.MFILE, ENOENT: E.NOENT, ENOSPC: E.NOSPC, ENOSYS: E.NOSYS, ENOTDIR: E.NOTDIR,
  ENOTEMPTY: E.NOTEMPTY, ENOTTY: E.NOTTY, EPERM: E.PERM, EPIPE: E.PIPE, EROFS: E.ROFS, ESRCH: E.SRCH, ETIMEDOUT: E.TIMEDOUT, EXDEV: E.XDEV,
  ELOOP: E.LOOP, ENAMETOOLONG: E.NAMETOOLONG, ENOTSUP: E.NOTSUP,
}

class Errno extends Error {
  constructor(readonly errno: number) {
    super(`wasi errno ${errno}`)
  }
}
/** Thrown by `proc_exit` to unwind the program. */
class WasiExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`)
  }
}

// ---- the host: what the framework needs from the world around it
export interface HostStat {
  kind: string
  size: number
  ino?: number
  nlink?: number
  atime?: number
  mtime?: number
  ctime?: number
}
export interface HostDirEntry {
  name: string
  kind: string
  ino?: number
}
/** The file calls of a Vanilla process (`tiny.open`, `tiny.read`, ...); any object with these works. All may return promises. */
export interface WasiFs {
  open(path: string, flags: number, mode?: number): number | Promise<number>
  close(fd: number): unknown
  read(fd: number, length: number, position?: number): Uint8Array | Promise<Uint8Array>
  write(fd: number, data: Uint8Array, position?: number): number | Promise<number>
  lseek(fd: number, offset: number, whence: number): number | Promise<number>
  fstat(fd: number): HostStat | Promise<HostStat>
  ftruncate(fd: number, size: number): unknown
  stat(path: string): HostStat | Promise<HostStat>
  lstat(path: string): HostStat | Promise<HostStat>
  readdir(path: string): HostDirEntry[] | Promise<HostDirEntry[]>
  mkdir(path: string, opts?: { mode?: number; recursive?: boolean }): unknown
  rmdir(path: string): unknown
  unlink(path: string): unknown
  rename(from: string, to: string): unknown
  symlink(target: string, path: string): unknown
  readlink(path: string): string | Promise<string>
  truncate(path: string, size: number): unknown
  utimes(path: string, atime: number, mtime: number): unknown
}
export interface WasiHost {
  fs: WasiFs
  /** Next bytes of standard input, or null at the end. */
  readStdin(max: number): Uint8Array | null | Promise<Uint8Array | null>
  /** Standard output (1) or error (2). */
  writeStd(fd: 1 | 2, data: Uint8Array): unknown
  /** Is this standard stream a terminal? */
  isTTY?(fd: 0 | 1 | 2): boolean
}

/** The host of a Vanilla process (`tiny`). */
export function hostFromTiny(tiny: any): WasiHost {
  return {
    fs: tiny,
    readStdin: (max) => tiny.stdin.read(max),
    writeStd: (fd, data) => (fd === 1 ? tiny.stdout : tiny.stderr).write(data),
    isTTY: (fd) => Boolean([tiny.stdin, tiny.stdout, tiny.stderr][fd]?.isTTY),
  }
}

export interface WasiOptions {
  host: WasiHost
  args?: string[]
  env?: Record<string, string>
  /** Guest path -> host folder. A program sees only these. `{'/': cwd}` makes the working directory the root. */
  preopens?: Record<string, string>
  /** Wrap the imports for JSPI. Default: when the engine has it. `false` leaves plain async functions for Asyncify glue. */
  suspend?: boolean
}

export interface Wasi {
  imports: { wasi_snapshot_preview1: Record<string, (...args: any[]) => unknown> }
  /** Run `_start` (or `_initialize` of a reactor) and resolve with the exit code. Calls `proc_exit` ends with its code. */
  start(instance: WebAssembly.Instance): Promise<number>
  /** For a runtime that runs the instance itself: tell the framework which memory is the guest's. */
  bind(memory: WebAssembly.Memory): void
}

type Dir = { kind: 'dir'; host: string; root: string; prestat: string | null }
type File = { kind: 'file'; fd: number; host: string; append: boolean }
type Std = { kind: 'std'; n: 0 | 1 | 2 }
type Entry = Dir | File | Std

const enc = new TextEncoder()
const dec = new TextDecoder()

/** Normalise `a/b/../c`; null if it climbs above the start. */
function walk(base: string, rel: string): string | null {
  const stack = base.split('/').filter(Boolean)
  const floor = stack.length
  for (const part of rel.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (stack.length <= floor) return null
      stack.pop()
    } else stack.push(part)
  }
  return `/${stack.join('/')}`
}

const kindType = (k: string) => (k === 'dir' || k === 'directory' ? TYPE.DIR : k === 'symlink' ? TYPE.SYMLINK : k === 'file' ? TYPE.FILE : TYPE.UNKNOWN)
const ns = (ms: number | undefined) => BigInt(Math.round((ms ?? 0) * 1e6))

export function createWasi(options: WasiOptions): Wasi {
  const { host } = options
  const fs = host.fs
  const args = options.args ?? []
  const env = Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`)
  let memory: WebAssembly.Memory | null = null
  const table = new Map<number, Entry>()
  table.set(0, { kind: 'std', n: 0 })
  table.set(1, { kind: 'std', n: 1 })
  table.set(2, { kind: 'std', n: 2 })
  let next = 3
  for (const [guest, hostPath] of Object.entries(options.preopens ?? {})) {
    const root = walk('/', hostPath) ?? '/'
    table.set(next++, { kind: 'dir', host: root, root, prestat: guest })
  }

  const view = () => new DataView(memory!.buffer)
  const bytes = () => new Uint8Array(memory!.buffer)
  const entry = (fd: number): Entry => {
    const e = table.get(fd)
    if (!e) throw new Errno(E.BADF)
    return e
  }
  const dirOf = (fd: number): Dir => {
    const e = entry(fd)
    if (e.kind !== 'dir') throw new Errno(E.NOTDIR)
    return e
  }
  const fileOf = (fd: number): File => {
    const e = entry(fd)
    if (e.kind === 'dir') throw new Errno(E.ISDIR)
    if (e.kind !== 'file') throw new Errno(E.SPIPE)
    return e
  }
  const read = (ptr: number, len: number) => dec.decode(bytes().subarray(ptr, ptr + len))
  /** Resolve a guest path against a directory descriptor; never leaves the preopened folder. */
  const resolve = (dir: Dir, ptr: number, len: number): string => {
    const rel = read(ptr, len)
    if (rel.startsWith('/')) throw new Errno(E.NOTCAPABLE)
    const full = walk(dir.host, rel)
    if (full === null || !(full === dir.root || full.startsWith(dir.root === '/' ? '/' : `${dir.root}/`))) throw new Errno(E.NOTCAPABLE)
    return full
  }
  const errno = (e: unknown): number => {
    if (e instanceof Errno) return e.errno
    const code = (e as { code?: string })?.code
    return (code && ERRNO_OF[code]) || E.IO
  }
  const iovs = (ptr: number, count: number): Array<[number, number]> => {
    const v = view()
    const out: Array<[number, number]> = []
    for (let i = 0; i < count; i++) out.push([v.getUint32(ptr + i * 8, true), v.getUint32(ptr + i * 8 + 4, true)])
    return out
  }

  const writeStat = (ptr: number, st: HostStat, type?: number): void => {
    const v = view()
    v.setBigUint64(ptr, 0n, true) // dev
    v.setBigUint64(ptr + 8, BigInt(st.ino ?? 0), true)
    v.setUint8(ptr + 16, type ?? kindType(st.kind))
    v.setBigUint64(ptr + 24, BigInt(st.nlink ?? 1), true)
    v.setBigUint64(ptr + 32, BigInt(Math.max(0, Math.floor(st.size ?? 0))), true)
    v.setBigUint64(ptr + 40, ns(st.atime ?? st.mtime), true)
    v.setBigUint64(ptr + 48, ns(st.mtime), true)
    v.setBigUint64(ptr + 56, ns(st.ctime ?? st.mtime), true)
  }

  const now = () => Date.now()
  const times = (flags: number, atim: bigint, mtim: bigint, cur: HostStat): [number, number] => {
    const a = flags & FST.ATIM_NOW ? now() : flags & FST.ATIM ? Number(atim / 1_000_000n) : (cur.atime ?? cur.mtime ?? now())
    const m = flags & FST.MTIM_NOW ? now() : flags & FST.MTIM ? Number(mtim / 1_000_000n) : (cur.mtime ?? now())
    return [a, m]
  }

  const closeEntry = async (fd: number): Promise<void> => {
    const e = entry(fd)
    if (e.kind === 'file') await fs.close(e.fd)
    table.delete(fd)
  }

  // Each import returns an errno (or a value for the few that do not). Failures become errno numbers.
  const guarded = <A extends unknown[]>(fn: (...a: A) => unknown | Promise<unknown>) => async (...a: A): Promise<number> => {
    try {
      return ((await fn(...a)) as number | undefined) ?? E.SUCCESS
    } catch (e) {
      if (e instanceof WasiExit) throw e
      return errno(e)
    }
  }

  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, Math.max(0, ms)))

  const api: Record<string, (...a: any[]) => unknown> = {
    args_sizes_get: guarded((countPtr: number, sizePtr: number) => {
      const v = view()
      v.setUint32(countPtr, args.length, true)
      v.setUint32(sizePtr, args.reduce((n, a) => n + enc.encode(a).length + 1, 0), true)
    }),
    args_get: guarded((argvPtr: number, bufPtr: number) => put(args, argvPtr, bufPtr)),
    environ_sizes_get: guarded((countPtr: number, sizePtr: number) => {
      const v = view()
      v.setUint32(countPtr, env.length, true)
      v.setUint32(sizePtr, env.reduce((n, a) => n + enc.encode(a).length + 1, 0), true)
    }),
    environ_get: guarded((envPtr: number, bufPtr: number) => put(env, envPtr, bufPtr)),

    clock_res_get: guarded((_id: number, ptr: number) => view().setBigUint64(ptr, 1000n, true)),
    clock_time_get: guarded((id: number, _precision: bigint, ptr: number) => {
      const t = id === 0 ? BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6)) : BigInt(Math.round(performance.now() * 1e6))
      view().setBigUint64(ptr, t, true)
    }),
    random_get: guarded((ptr: number, len: number) => {
      const out = bytes().subarray(ptr, ptr + len)
      for (let i = 0; i < len; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(len, i + 65536)))
    }),
    sched_yield: guarded(() => sleep(0)),
    proc_raise: guarded(() => {
      throw new Errno(E.NOSYS)
    }),
    proc_exit: (code: number) => {
      throw new WasiExit(code)
    },

    fd_close: guarded((fd: number) => closeEntry(fd)),
    fd_renumber: guarded(async (from: number, to: number) => {
      entry(from)
      if (table.has(to)) await closeEntry(to)
      table.set(to, table.get(from)!)
      table.delete(from)
    }),
    fd_sync: guarded(() => undefined),
    fd_datasync: guarded(() => undefined),
    fd_advise: guarded(() => undefined),
    fd_allocate: guarded(() => undefined),
    fd_fdstat_set_flags: guarded(() => undefined),
    fd_fdstat_set_rights: guarded(() => undefined),
    fd_fdstat_get: guarded((fd: number, ptr: number) => {
      const e = entry(fd)
      const v = view()
      v.setUint8(ptr, e.kind === 'dir' ? TYPE.DIR : e.kind === 'std' ? TYPE.CHAR : TYPE.FILE)
      v.setUint16(ptr + 2, e.kind === 'file' && e.append ? FDFLAGS_APPEND : 0, true)
      v.setBigUint64(ptr + 8, ALL_RIGHTS, true)
      v.setBigUint64(ptr + 16, ALL_RIGHTS, true)
    }),
    fd_prestat_get: guarded((fd: number, ptr: number) => {
      const e = table.get(fd)
      if (!e || e.kind !== 'dir' || e.prestat === null) throw new Errno(E.BADF)
      const v = view()
      v.setUint8(ptr, 0)
      v.setUint32(ptr + 4, enc.encode(e.prestat).length, true)
    }),
    fd_prestat_dir_name: guarded((fd: number, ptr: number, len: number) => {
      const e = table.get(fd)
      if (!e || e.kind !== 'dir' || e.prestat === null) throw new Errno(E.BADF)
      bytes().set(enc.encode(e.prestat).subarray(0, len), ptr)
    }),

    fd_read: guarded(async (fd: number, iovPtr: number, count: number, outPtr: number) => {
      const e = entry(fd)
      if (e.kind === 'dir') throw new Errno(E.ISDIR)
      let total = 0
      for (const [ptr, len] of iovs(iovPtr, count)) {
        if (!len) continue
        const chunk = e.kind === 'std' ? (e.n === 0 ? await host.readStdin(len) : null) : await fs.read(e.fd, len)
        if (e.kind === 'std' && e.n !== 0) throw new Errno(E.BADF)
        if (!chunk || !chunk.length) break
        bytes().set(chunk.subarray(0, len), ptr)
        total += Math.min(chunk.length, len)
        if (chunk.length < len) break
      }
      view().setUint32(outPtr, total, true)
    }),
    fd_pread: guarded(async (fd: number, iovPtr: number, count: number, offset: bigint, outPtr: number) => {
      const e = fileOf(fd)
      let pos = Number(offset)
      let total = 0
      for (const [ptr, len] of iovs(iovPtr, count)) {
        if (!len) continue
        const chunk = await fs.read(e.fd, len, pos)
        if (!chunk.length) break
        bytes().set(chunk, ptr)
        total += chunk.length
        pos += chunk.length
        if (chunk.length < len) break
      }
      view().setUint32(outPtr, total, true)
    }),
    fd_write: guarded(async (fd: number, iovPtr: number, count: number, outPtr: number) => {
      const e = entry(fd)
      if (e.kind === 'dir') throw new Errno(E.ISDIR)
      let total = 0
      for (const [ptr, len] of iovs(iovPtr, count)) {
        if (!len) continue
        const data = bytes().slice(ptr, ptr + len)
        if (e.kind === 'std') {
          if (e.n === 0) throw new Errno(E.BADF)
          await host.writeStd(e.n, data)
          total += len
        } else total += await fs.write(e.fd, data)
      }
      view().setUint32(outPtr, total, true)
    }),
    fd_pwrite: guarded(async (fd: number, iovPtr: number, count: number, offset: bigint, outPtr: number) => {
      const e = fileOf(fd)
      let pos = Number(offset)
      let total = 0
      for (const [ptr, len] of iovs(iovPtr, count)) {
        if (!len) continue
        const n = await fs.write(e.fd, bytes().slice(ptr, ptr + len), pos)
        total += n
        pos += n
      }
      view().setUint32(outPtr, total, true)
    }),
    fd_seek: guarded(async (fd: number, offset: bigint, whence: number, outPtr: number) => {
      const e = entry(fd)
      if (e.kind === 'std') throw new Errno(E.SPIPE)
      if (e.kind === 'dir') throw new Errno(E.ISDIR)
      if (whence > 2) throw new Errno(E.INVAL)
      view().setBigUint64(outPtr, BigInt(await fs.lseek(e.fd, Number(offset), whence)), true)
    }),
    fd_tell: guarded(async (fd: number, outPtr: number) => {
      const e = fileOf(fd)
      view().setBigUint64(outPtr, BigInt(await fs.lseek(e.fd, 0, 1)), true)
    }),
    fd_filestat_get: guarded(async (fd: number, ptr: number) => {
      const e = entry(fd)
      if (e.kind === 'std') return writeStat(ptr, { kind: 'char', size: 0 }, TYPE.CHAR)
      writeStat(ptr, e.kind === 'dir' ? await fs.stat(e.host) : await fs.fstat(e.fd))
    }),
    fd_filestat_set_size: guarded(async (fd: number, size: bigint) => {
      const e = fileOf(fd)
      await fs.ftruncate(e.fd, Number(size))
    }),
    fd_filestat_set_times: guarded(async (fd: number, atim: bigint, mtim: bigint, flags: number) => {
      const e = entry(fd)
      if (e.kind === 'std') return
      const path = e.host
      const [a, m] = times(flags, atim, mtim, await fs.stat(path))
      await fs.utimes(path, a, m)
    }),
    fd_readdir: guarded(async (fd: number, bufPtr: number, bufLen: number, cookie: bigint, usedPtr: number) => {
      const d = dirOf(fd)
      const list: HostDirEntry[] = [{ name: '.', kind: 'dir' }, { name: '..', kind: 'dir' }, ...(await fs.readdir(d.host))]
      const out = bytes()
      const v = view()
      let used = 0
      for (let i = Number(cookie); i < list.length; i++) {
        const name = enc.encode(list[i]!.name)
        const head = new DataView(new ArrayBuffer(24))
        head.setBigUint64(0, BigInt(i + 1), true)
        head.setBigUint64(8, BigInt(list[i]!.ino ?? 0), true)
        head.setUint32(16, name.length, true)
        head.setUint8(20, kindType(list[i]!.kind))
        const piece = new Uint8Array(24 + name.length)
        piece.set(new Uint8Array(head.buffer), 0)
        piece.set(name, 24)
        const room = bufLen - used
        out.set(piece.subarray(0, room), bufPtr + used)
        used += Math.min(piece.length, room)
        if (piece.length > room) break // the buffer is full: the guest reads again from this cookie
      }
      v.setUint32(usedPtr, used, true)
    }),

    path_open: guarded(async (dirfd: number, dirflags: number, pathPtr: number, pathLen: number, oflags: number, rights: bigint, _inh: bigint, fdflags: number, outPtr: number) => {
      const d = dirOf(dirfd)
      const path = resolve(d, pathPtr, pathLen)
      const st = await fs.stat(path).catch((e) => {
        if (errno(e) !== E.NOENT || !(oflags & OFLAGS.CREAT)) throw e
        return null
      })
      if (st && oflags & OFLAGS.CREAT && oflags & OFLAGS.EXCL) throw new Errno(E.EXIST)
      if (st && kindType(st.kind) === TYPE.DIR) {
        if (oflags & (OFLAGS.TRUNC | OFLAGS.CREAT) && !(oflags & OFLAGS.DIRECTORY) && rights & RIGHT_WRITE) throw new Errno(E.ISDIR)
        table.set(next, { kind: 'dir', host: path, root: d.root, prestat: null })
        view().setUint32(outPtr, next++, true)
        return
      }
      if (oflags & OFLAGS.DIRECTORY) throw new Errno(st ? E.NOTDIR : E.NOENT)
      const wantsWrite = Boolean(rights & RIGHT_WRITE) || Boolean(oflags & OFLAGS.TRUNC)
      const wantsRead = Boolean(rights & RIGHT_READ)
      let flags = wantsWrite ? (wantsRead ? HOST_O.RDWR : HOST_O.WRONLY) : HOST_O.RDONLY
      if (oflags & OFLAGS.CREAT) flags |= HOST_O.CREAT
      if (oflags & OFLAGS.EXCL) flags |= HOST_O.EXCL
      if (oflags & OFLAGS.TRUNC) flags |= HOST_O.TRUNC
      const append = Boolean(fdflags & FDFLAGS_APPEND)
      if (append) flags |= HOST_O.APPEND
      const hfd = await fs.open(path, flags, 0o666)
      table.set(next, { kind: 'file', fd: hfd, host: path, append })
      view().setUint32(outPtr, next++, true)
    }),
    path_create_directory: guarded(async (dirfd: number, ptr: number, len: number) => {
      await fs.mkdir(resolve(dirOf(dirfd), ptr, len))
    }),
    path_remove_directory: guarded(async (dirfd: number, ptr: number, len: number) => {
      await fs.rmdir(resolve(dirOf(dirfd), ptr, len))
    }),
    path_unlink_file: guarded(async (dirfd: number, ptr: number, len: number) => {
      await fs.unlink(resolve(dirOf(dirfd), ptr, len))
    }),
    path_rename: guarded(async (fromFd: number, fromPtr: number, fromLen: number, toFd: number, toPtr: number, toLen: number) => {
      await fs.rename(resolve(dirOf(fromFd), fromPtr, fromLen), resolve(dirOf(toFd), toPtr, toLen))
    }),
    path_filestat_get: guarded(async (dirfd: number, flags: number, ptr: number, len: number, outPtr: number) => {
      const path = resolve(dirOf(dirfd), ptr, len)
      writeStat(outPtr, flags & 1 ? await fs.stat(path) : await fs.lstat(path))
    }),
    path_filestat_set_times: guarded(async (dirfd: number, flags: number, ptr: number, len: number, atim: bigint, mtim: bigint, fstFlags: number) => {
      const path = resolve(dirOf(dirfd), ptr, len)
      const [a, m] = times(fstFlags, atim, mtim, flags & 1 ? await fs.stat(path) : await fs.lstat(path))
      await fs.utimes(path, a, m)
    }),
    path_symlink: guarded(async (oldPtr: number, oldLen: number, dirfd: number, newPtr: number, newLen: number) => {
      await fs.symlink(read(oldPtr, oldLen), resolve(dirOf(dirfd), newPtr, newLen))
    }),
    path_readlink: guarded(async (dirfd: number, ptr: number, len: number, bufPtr: number, bufLen: number, usedPtr: number) => {
      const target = enc.encode(await fs.readlink(resolve(dirOf(dirfd), ptr, len))).subarray(0, bufLen)
      bytes().set(target, bufPtr)
      view().setUint32(usedPtr, target.length, true)
    }),
    path_link: guarded(() => {
      throw new Errno(E.NOSYS)
    }),

    poll_oneoff: guarded(async (inPtr: number, eventsPtr: number, count: number, neventsPtr: number) => {
      if (!count) throw new Errno(E.INVAL)
      const v = view()
      const subs: Array<{ user: bigint; tag: number; fd: number; deadline: number }> = []
      const start = performance.now()
      for (let i = 0; i < count; i++) {
        const p = inPtr + i * 48
        const tag = v.getUint8(p + 8)
        if (tag === 0) {
          const timeout = Number(v.getBigUint64(p + 24, true)) / 1e6
          const abs = (v.getUint16(p + 40, true) & 1) === 1
          const clock = v.getUint32(p + 16, true)
          const wait = abs ? timeout - (clock === 0 ? performance.timeOrigin + performance.now() : performance.now()) : timeout
          subs.push({ user: v.getBigUint64(p, true), tag, fd: -1, deadline: start + Math.max(0, wait) })
        } else subs.push({ user: v.getBigUint64(p, true), tag, fd: v.getUint32(p + 16, true), deadline: Infinity })
      }
      // Descriptor subscriptions are ready at once (reads on a file or stream complete or report end); otherwise sleep until the first clock.
      const ready = subs.filter((s) => s.tag !== 0)
      const firing = ready.length ? ready : (() => {
        const first = Math.min(...subs.map((s) => s.deadline))
        return subs.filter((s) => s.deadline <= first)
      })()
      if (!ready.length) await sleep(Math.min(...subs.map((s) => s.deadline)) - performance.now())
      const o = view()
      firing.forEach((s, i) => {
        const p = eventsPtr + i * 32
        o.setBigUint64(p, s.user, true)
        o.setUint16(p + 8, table.has(s.fd) || s.tag === 0 ? 0 : E.BADF, true)
        o.setUint8(p + 10, s.tag)
        o.setBigUint64(p + 16, 0n, true)
        o.setUint16(p + 24, 0, true)
      })
      o.setUint32(neventsPtr, firing.length, true)
    }),

    sock_accept: guarded(() => {
      throw new Errno(E.NOSYS)
    }),
    sock_recv: guarded(() => {
      throw new Errno(E.NOSYS)
    }),
    sock_send: guarded(() => {
      throw new Errno(E.NOSYS)
    }),
    sock_shutdown: guarded(() => {
      throw new Errno(E.NOSYS)
    }),
  }
  function put(strings: string[], listPtr: number, bufPtr: number): void {
    const v = view()
    const b = bytes()
    let at = bufPtr
    strings.forEach((s, i) => {
      v.setUint32(listPtr + i * 4, at, true)
      const e = enc.encode(s)
      b.set(e, at)
      b[at + e.length] = 0
      at += e.length + 1
    })
  }

  const Suspending = (WebAssembly as unknown as { Suspending?: new (fn: (...a: any[]) => unknown) => unknown }).Suspending
  const Promising = (WebAssembly as unknown as { promising?: (fn: (...a: any[]) => unknown) => (...a: any[]) => Promise<unknown> }).promising
  const suspend = options.suspend ?? (Boolean(Suspending) && Boolean(Promising))
  const wrapped: Record<string, (...a: any[]) => unknown> = {}
  for (const [name, fn] of Object.entries(api)) wrapped[name] = suspend && name !== 'proc_exit' && Suspending ? (new Suspending(fn) as never) : fn

  return {
    imports: { wasi_snapshot_preview1: wrapped },
    bind: (m) => {
      memory = m
    },
    async start(instance) {
      memory = (instance.exports.memory as WebAssembly.Memory) ?? memory
      if (!memory) throw new Error('the module exports no memory')
      const exports = instance.exports as Record<string, unknown>
      const entryFn = (exports._start ?? exports._initialize) as ((...a: any[]) => unknown) | undefined
      if (typeof entryFn !== 'function') throw new Error('the module exports neither _start nor _initialize')
      try {
        if (suspend && Promising) await Promising(entryFn)()
        else await entryFn()
        return 0
      } catch (e) {
        if (e instanceof WasiExit) return e.code
        throw e
      } finally {
        for (const [fd, e] of [...table]) if (e.kind === 'file') await Promise.resolve(fs.close(e.fd)).catch(() => {}), table.delete(fd)
      }
    },
  }
}
