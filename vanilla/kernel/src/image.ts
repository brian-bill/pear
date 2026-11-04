/// Disk images: the whole hierarchy (or parts of it) in one file, for backup and moving between browsers.
///
/// Layout of a `.tinyimg` file:
///
///   magic "TINYIMG\0" (8) | version u16 | flags u16 | header length u32 | header (JSON) | body | "END!" | crc32 u32
///
/// The body is a run of records, `meta length u32 | meta (JSON) | content (meta.size bytes)`, ended by a record
/// of length 0. It is gzip-compressed when `flags` bit 0 is set. The checksum covers every byte before `END!`
/// as stored, so a damaged image is detected without decompressing it.
import { ByteReader, END_RECORD, FLAG_GZIP, bodyStream, frame, gzipped, readRecord, record, unframe } from './container'
import { SysError } from './errors'
import type { FileSystem, Stat } from './fs'

export { crc32 } from './container'

const IMAGE_MAGIC = 'TINYIMG\0'
/** An encrypted image: magic | salt (16) | iv (12) | AES-GCM of a whole plain image (key from the passphrase, PBKDF2-SHA-256). */
const ENCRYPTED_MAGIC = 'TINYENC\0'
const PBKDF2_ROUNDS = 210_000
const IMAGE_VERSION = 1
/** Images older than this are no longer read. */
const IMAGE_MIN_VERSION = 1

const enc = new TextEncoder()
const dec = new TextDecoder()

const DEFAULT_EXCLUDE = ['/tmp', '/dev', '/var/db/.session']

interface ImageHeader {
  version: number
  created: number
  osVersion: string
  roots: string[]
  entries: number
  /** Bytes of file content. */
  bytes: number
  compressed: boolean
}

export interface ImageCreateOptions {
  /** Paths to include, with everything below. Default: `/`. */
  include?: string[]
  /** Paths to leave out. Default: `/tmp`, `/dev`, and the session marker. Mounted host volumes are always left out. */
  exclude?: string[]
  /** gzip the body. Default true. */
  compress?: boolean
  /** Called with `(entries, bytes)` as the image grows; return `false` to cancel (`ECANCELED`). */
  progress?: (entries: number, bytes: number) => boolean | void
  /** Encrypt the image with this passphrase (AES-GCM). The whole image is held in memory while it is sealed. */
  passphrase?: string
}

export interface ImageInfo extends ImageHeader {
  ok: boolean
  /** Why the image is not usable (corrupt, too new, not an image). */
  error?: string
  /** The image is encrypted: pass `passphrase` to read its header. */
  encrypted?: boolean
  size: number
}

export interface RestoreOptions {
  /** `replace` first removes everything under the roots the image covers and ends all processes. Needs `confirm`. */
  mode: 'replace' | 'merge'
  /** Required for `replace`: the user agreed to lose what is there. */
  confirm?: boolean
  /** For an encrypted image. */
  passphrase?: string
  progress?: (entries: number, bytes: number) => boolean | void
}

export interface RestoreResult {
  files: number
  dirs: number
  symlinks: number
  bytes: number
  /** Entries that could not be placed (a file where a directory is, ...), by path. */
  skipped: Record<string, string>
  /** After `replace` the running system no longer matches the disk: reload. */
  restartRequired: boolean
}

interface Meta {
  path: string
  kind: 'file' | 'dir' | 'symlink'
  mode: number
  uid: number
  gid: number
  atime: number
  mtime: number
  size: number
  target?: string
  xattrs?: Record<string, string>
}

const within = (path: string, root: string) => root === '/' || path === root || path.startsWith(`${root}/`)
const norm = (p: string) => (p.length > 1 && p.endsWith('/') ? p.slice(0, -1) : p)
const join = (dir: string, name: string) => (dir === '/' ? `/${name}` : `${dir}/${name}`)

const keyFrom = async (passphrase: string, salt: Uint8Array) => {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey'])
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: salt as BufferSource, iterations: PBKDF2_ROUNDS, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  )
}

async function isEncrypted(file: Blob): Promise<boolean> {
  return file.size > 8 && dec.decode(new Uint8Array(await file.slice(0, 8).arrayBuffer())) === ENCRYPTED_MAGIC
}

async function seal(plain: Blob, passphrase: string): Promise<Blob> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const key = await keyFrom(passphrase, salt)
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, await plain.arrayBuffer())
  return new Blob([enc.encode(ENCRYPTED_MAGIC) as BlobPart, salt as BlobPart, iv as BlobPart, sealed], { type: 'application/x-tinyimg' })
}

async function unseal(file: Blob, passphrase: string): Promise<Blob> {
  const head = new Uint8Array(await file.slice(8, 36).arrayBuffer())
  if (head.length < 28) throw new SysError('EIO', 'the image is incomplete')
  const key = await keyFrom(passphrase, head.subarray(0, 16))
  try {
    return new Blob([await crypto.subtle.decrypt({ name: 'AES-GCM', iv: head.subarray(16, 28) }, key, await file.slice(36).arrayBuffer())])
  } catch {
    throw new SysError('EACCES', 'wrong passphrase, or the image is damaged')
  }
}

export class Images {
  /** `mounts` lists mount points: host volumes are never part of an image. */
  constructor(
    private fs: FileSystem,
    private osVersion: string,
    private mounts: () => string[],
  ) {}

  async create(opts: ImageCreateOptions = {}): Promise<Blob> {
    const roots = (opts.include?.length ? opts.include : ['/']).map(norm)
    // asking for a folder that is normally left out (`/tmp`) includes it
    const skip = (opts.exclude ?? DEFAULT_EXCLUDE.filter((x) => !roots.some((r) => within(r, x)))).map(norm)
    const exclude = [...skip, ...this.mounts().map(norm)]
    const parts: BlobPart[] = []
    let entries = 0
    let bytes = 0
    const tick = async () => {
      if (opts.progress?.(entries, bytes) === false) throw new SysError('ECANCELED', 'the export was canceled')
      if (entries % 50 === 0) await new Promise((r) => setTimeout(r)) // let a cancel request in
    }
    const written = new Set<string>()
    const put = async (path: string, st: Stat) => {
      written.add(path)
      const meta: Meta = { path, kind: st.kind, mode: st.mode, uid: st.uid, gid: st.gid, atime: st.atime, mtime: st.mtime, size: 0 }
      let content: Uint8Array | null = null
      if (st.kind === 'symlink') meta.target = await this.fs.readlink(path)
      if (st.kind === 'file') {
        content = await this.fs.readFile(path)
        meta.size = content.length
      }
      // xattr calls follow links, so a link would report (and later change) its target's
      const names = st.kind === 'symlink' ? [] : await this.fs.listxattr(path)
      if (names.length) {
        meta.xattrs = {}
        for (const n of names) meta.xattrs[n] = (await this.fs.getxattr(path, n)) ?? ''
      }
      parts.push(...record(meta, content ?? undefined))
      if (content) bytes += content.length
      entries++
      await tick()
    }
    const walk = async (path: string): Promise<void> => {
      if (exclude.some((x) => within(path, x))) return
      const st = await this.fs.lstat(path)
      if (path !== '/' && !written.has(path)) await put(path, st)
      if (st.kind !== 'dir') return
      for (const e of await this.fs.readdir(path)) await walk(join(path, e.name))
    }
    for (const root of roots) {
      // a root's ancestors come first so that restoring the image into an empty system works
      const chain = root.split('/').filter(Boolean)
      for (let i = 1; i < chain.length; i++) {
        const dir = `/${chain.slice(0, i).join('/')}`
        if (!written.has(dir) && !exclude.some((x) => within(dir, x))) await put(dir, await this.fs.lstat(dir))
      }
      await walk(root)
    }
    parts.push(END_RECORD as BlobPart)

    const compress = opts.compress ?? true
    let body = new Blob(parts)
    if (compress) body = await gzipped(body)
    const header: ImageHeader = { version: IMAGE_VERSION, created: Date.now(), osVersion: this.osVersion, roots, entries, bytes, compressed: compress }
    const plain = await frame(IMAGE_MAGIC, IMAGE_VERSION, compress ? FLAG_GZIP : 0, header, body, 'application/x-tinyimg')
    return opts.passphrase ? seal(plain, opts.passphrase) : plain
  }

    async verify(file: Blob, passphrase?: string): Promise<ImageInfo> {
    const blank: ImageHeader = { version: 0, created: 0, osVersion: '', roots: [], entries: 0, bytes: 0, compressed: false }
    const encrypted = await isEncrypted(file)
    try {
      const { header } = await this.open(file, passphrase)
      return { ...header, ok: true, size: file.size, ...(encrypted ? { encrypted } : {}) }
    } catch (e) {
      return { ...blank, ok: false, error: (e as Error).message, size: file.size, ...(encrypted ? { encrypted } : {}) }
    }
  }

    private async open(file: Blob, passphrase?: string): Promise<{ header: ImageHeader; body: Blob; gzip: boolean }> {
    if (await isEncrypted(file)) {
      if (!passphrase) throw new SysError('EACCES', 'this image is encrypted: a passphrase is needed')
      file = await unseal(file, passphrase)
    }
    const { header, body, gzip } = await unframe(file, { magic: IMAGE_MAGIC, version: IMAGE_VERSION, minVersion: IMAGE_MIN_VERSION, what: 'Pear disk image', noun: 'image' })
    return { header: header as ImageHeader, body, gzip }
  }

  async restore(file: Blob, opts: RestoreOptions, beforeReplace?: () => Promise<void>): Promise<RestoreResult> {
    if (opts.mode !== 'replace' && opts.mode !== 'merge') throw new SysError('EINVAL', 'mode must be replace or merge')
    if (opts.mode === 'replace' && !opts.confirm) throw new SysError('EPERM', 'replacing the file system needs confirmation')
    const { header, body, gzip } = await this.open(file, opts.passphrase) // nothing is touched until the image is known to be good

    if (opts.mode === 'replace') {
      await beforeReplace?.()
      const keep = this.mounts().map(norm)
      for (const root of header.roots) {
        if (root === '/') {
          for (const e of await this.fs.readdir('/')) await this.clear(join('/', e.name), keep)
        } else {
          await this.clear(root, keep)
        }
      }
    }

    const res: RestoreResult = { files: 0, dirs: 0, symlinks: 0, bytes: 0, skipped: {}, restartRequired: opts.mode === 'replace' }
    const reader = new ByteReader(bodyStream(body, gzip))
    let count = 0
    const dirs: Array<[string, Meta]> = []
    try {
      for (;;) {
        const rec = await readRecord<Meta>(reader)
        if (!rec) break
        await this.place(rec.meta, rec.content, res, dirs)
        count++
        if (opts.progress?.(count, res.bytes) === false) throw new SysError('ECANCELED', 'the import was canceled')
        if (count % 50 === 0) await new Promise((r) => setTimeout(r))
      }
    } finally {
      reader.cancel()
    }
    // directories last, deepest first, so that their modes (possibly read-only) and times are not disturbed by their contents
    for (const [path, meta] of dirs.sort((a, b) => b[0].length - a[0].length)) await this.finish(path, meta)
    await this.fs.flush()
    return res
  }

  private async clear(path: string, keep: string[]): Promise<void> {
    if (keep.some((k) => within(k, path) && k !== path)) {
      // a mount point lives below: empty around it
      for (const e of await this.fs.readdir(path)) await this.clear(join(path, e.name), keep)
      return
    }
    if (keep.includes(path)) return
    await this.fs.removeAll(path).catch(async () => {
      await this.fs.unlink(path)
    })
  }

  private async place(meta: Meta, content: Uint8Array | null, res: RestoreResult, dirs: Array<[string, Meta]>): Promise<void> {
    const path = meta.path
    if (typeof path !== 'string' || !path.startsWith('/') || path.split('/').includes('..')) throw new SysError('EIO', `the image has an invalid path ${JSON.stringify(path)}`)
    try {
      const existing = await this.fs.lstat(path).catch(() => null)
      if (existing && (existing.kind !== meta.kind || meta.kind === 'symlink')) {
        if (existing.kind === 'dir' || meta.kind === 'dir') {
          res.skipped[path] = `a ${existing.kind} is in the way`
          return
        }
        await this.fs.unlink(path)
      }
      if (meta.kind === 'dir') {
        if (!existing) await this.fs.as(meta.uid, meta.gid, () => this.fs.mkdir(path, { recursive: true }))
        dirs.push([path, meta])
        res.dirs++
        return
      }
      if (meta.kind === 'symlink') {
        await this.fs.as(meta.uid, meta.gid, () => this.fs.symlink(meta.target ?? '', path))
        res.symlinks++ // created by `as` with the right owner; chown and xattr calls would follow the link
        return
      }
      await this.fs.as(meta.uid, meta.gid, () => this.fs.writeFile(path, content ?? new Uint8Array(0)))
      await this.finish(path, meta)
      res.files++
      res.bytes += meta.size
    } catch (e) {
      res.skipped[path] = (e as Error).message
    }
  }

  private async finish(path: string, meta: Meta): Promise<void> {
    await this.fs.chown(path, meta.uid, meta.gid)
    await this.fs.chmod(path, meta.mode)
    await this.fs.utimes(path, meta.atime, meta.mtime)
    for (const [name, value] of Object.entries(meta.xattrs ?? {})) await this.fs.setxattr(path, name, value)
  }
}
