/// Moving files between the host computer and the VFS (`contracts/import-export.md`): pickers, drops, downloads, and
/// scheduled disk-image backups. Runs on the page, because pickers and downloads need a user gesture and the DOM.
/// Where the File System Access API is missing it falls back to file inputs and downloads.
import type { Kernel } from './client'
import { crc32 } from './image'

const O_WRONLY = 1
const O_CREAT = 0x40
const O_TRUNC = 0x200
const O_RDONLY = 0
const CHUNK = 4 * 1024 * 1024

interface ImportItem {
  /** Path below the destination, with `/`. Folders chosen as a whole keep their structure. */
  path: string
  file: File
}

interface ImportSession {
  items: ImportItem[]
  /** Directories with nothing in them, so they are created too. */
  emptyDirs: string[]
  bytes: number
}

interface TransferOptions {
  /** Called with bytes done and total; return `false` to cancel (`ECANCELED`). */
  progress?: (done: number, total: number) => boolean | void
  signal?: AbortSignal
}

const cancelled = () => Object.assign(new Error('the transfer was cancelled'), { code: 'ECANCELED' })
const session = (items: ImportItem[], emptyDirs: string[] = []): ImportSession => ({ items, emptyDirs, bytes: items.reduce((n, i) => n + i.file.size, 0) })
const abortedAsEmpty = (e: unknown): ImportSession => {
  if ((e as Error).name === 'AbortError') return session([])
  throw e
}
const clean = (p: string) => p.replace(/^\/+/, '').split('/').filter((s) => s && s !== '.' && s !== '..').join('/')

const pipeToHandle = async (handle: FileSystemFileHandle, blob: Blob) =>
  blob.stream().pipeTo(await (handle as unknown as { createWritable(): Promise<WritableStream> }).createWritable())

type Picker = {
  showOpenFilePicker?: (o?: object) => Promise<Array<{ getFile(): Promise<File> }>>
  showSaveFilePicker?: (o?: object) => Promise<FileSystemFileHandle>
  showDirectoryPicker?: (o?: object) => Promise<FileSystemDirectoryHandle>
}

// ---------------------------------------------------------------- import

/** Must run from a click or key press. */
export async function importPick(opts: { multiple?: boolean; accept?: string[] } = {}): Promise<ImportSession> {
  const w = window as unknown as Picker
  if (w.showOpenFilePicker) {
    try {
      const handles = await w.showOpenFilePicker({ multiple: opts.multiple ?? true })
      const files = await Promise.all(handles.map((h) => h.getFile()))
      return session(files.map((file) => ({ path: file.name, file })))
    } catch (e) {
      return abortedAsEmpty(e)
    }
  }
  const files = await fromInput({ multiple: opts.multiple ?? true, accept: opts.accept?.join(',') })
  return session(files.map((file) => ({ path: file.name, file })))
}

export async function importDirectory(): Promise<ImportSession> {
  const w = window as unknown as Picker
  if (w.showDirectoryPicker) {
    try {
      const root = await w.showDirectoryPicker()
      const items: ImportItem[] = []
      const empty: string[] = []
      await walkHandle(root, root.name, items, empty)
      return session(items, empty)
    } catch (e) {
      return abortedAsEmpty(e)
    }
  }
  const files = await fromInput({ multiple: true, directory: true })
  return session(files.map((file) => ({ path: (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name, file })))
}

/** What the user dropped on the page, folders included. Call `event.preventDefault()` on `dragover` first. */
export async function importFromDrop(event: DragEvent): Promise<ImportSession> {
  const items: ImportItem[] = []
  const empty: string[] = []
  const entries = [...(event.dataTransfer?.items ?? [])].map((i) => i.webkitGetAsEntry?.() ?? null)
  if (entries.some(Boolean)) {
    for (const entry of entries) if (entry) await walkEntry(entry, '', items, empty)
  } else {
    for (const file of event.dataTransfer?.files ?? []) items.push({ path: file.name, file })
  }
  return session(items, empty)
}

function fromInput(o: { multiple: boolean; accept?: string; directory?: boolean }): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.multiple = o.multiple
    if (o.accept) input.accept = o.accept
    if (o.directory) (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true
    input.onchange = () => resolve([...(input.files ?? [])])
    input.oncancel = () => resolve([])
    input.click()
  })
}

async function walkHandle(dir: FileSystemDirectoryHandle, prefix: string, items: ImportItem[], empty: string[]): Promise<void> {
  let count = 0
  for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
    count++
    if (handle.kind === 'file') items.push({ path: `${prefix}/${name}`, file: await (handle as FileSystemFileHandle).getFile() })
    else await walkHandle(handle as FileSystemDirectoryHandle, `${prefix}/${name}`, items, empty)
  }
  if (!count) empty.push(prefix)
}

async function walkEntry(entry: FileSystemEntry, prefix: string, items: ImportItem[], empty: string[]): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    items.push({ path, file })
    return
  }
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  let count = 0
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (!batch.length) break
    for (const child of batch) (count++, await walkEntry(child, path, items, empty))
  }
  if (!count) empty.push(path)
}

/**
 * Copy a session into the VFS below `dest` (a folder). Files are streamed in chunks, so a large file does not sit in
 * memory. Each file gets a `com.apple.quarantine` attribute recording where it came from. An existing file is replaced
 * unless `keepExisting`. Returns the paths written.
 */
export async function importCommit(kernel: Kernel, s: ImportSession, dest: string, opts: TransferOptions & { keepExisting?: boolean; quarantine?: boolean } = {}): Promise<string[]> {
  const base = dest.replace(/\/+$/, '') || ''
  await kernel.mkdir(base || '/', { recursive: true })
  for (const dir of s.emptyDirs) await kernel.mkdir(`${base}/${clean(dir)}`, { recursive: true })
  const written: string[] = []
  let done = 0
  for (const item of s.items) {
    if (opts.signal?.aborted) throw cancelled()
    const rel = clean(item.path)
    if (!rel) continue
    const target = `${base}/${rel}`
    if (opts.keepExisting && (await kernel.exists(target))) continue
    await kernel.mkdir(target.slice(0, target.lastIndexOf('/')) || '/', { recursive: true })
    const fd = await kernel.open(target, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
    try {
      const reader = item.file.stream().getReader()
      for (;;) {
        const { done: end, value } = await reader.read()
        if (end) break
        for (let at = 0; at < value.length; at += CHUNK) {
          await kernel.write(fd, value.subarray(at, at + CHUNK))
          done += Math.min(CHUNK, value.length - at)
          if (opts.progress?.(done, s.bytes) === false) {
            await reader.cancel()
            throw cancelled()
          }
        }
      }
    } catch (e) {
      await kernel.close(fd).catch(() => {})
      await kernel.unlink(target).catch(() => {}) // never leave half a file
      throw e
    }
    await kernel.close(fd)
    if (opts.quarantine !== false) await kernel.setxattr(target, 'com.apple.quarantine', `0081;${Date.now().toString(16)};host;${item.file.name}`).catch(() => {})
    written.push(target)
  }
  return written
}

// ---------------------------------------------------------------- export

async function saveBlob(blob: Blob, name: string, saveAs: boolean): Promise<void> {
  const w = window as unknown as Picker
  if (saveAs && w.showSaveFilePicker) {
    try {
      const handle = await w.showSaveFilePicker({ suggestedName: name })
      await pipeToHandle(handle, blob)
      return
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw cancelled()
      // fall through to a plain download
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

async function fileBlob(kernel: Kernel, path: string, opts: TransferOptions, total: number, soFar: { n: number }): Promise<Blob> {
  const parts: BlobPart[] = []
  const fd = await kernel.open(path, O_RDONLY)
  try {
    for (let at = 0; ; ) {
      if (opts.signal?.aborted) throw cancelled()
      const chunk = await kernel.read(fd, CHUNK, at)
      if (!chunk.length) break
      parts.push(chunk as BlobPart)
      at += chunk.length
      soFar.n += chunk.length
      if (opts.progress?.(soFar.n, total) === false) throw cancelled()
    }
  } finally {
    await kernel.close(fd).catch(() => {})
  }
  return new Blob(parts)
}

export async function exportFile(kernel: Kernel, path: string, opts: TransferOptions & { saveAs?: boolean; name?: string } = {}): Promise<void> {
  const st = await kernel.stat(path)
  if (st.kind !== 'file') throw Object.assign(new Error('not a file'), { code: 'EISDIR' })
  const blob = await fileBlob(kernel, path, opts, st.size, { n: 0 })
  await saveBlob(blob, opts.name ?? path.slice(path.lastIndexOf('/') + 1), opts.saveAs ?? false)
}

/** A folder as a zip download, or written into a host folder when `toHost` is set and the browser supports it. */
export async function exportDirectory(kernel: Kernel, path: string, opts: TransferOptions & { toHost?: boolean; saveAs?: boolean } = {}): Promise<void> {
  const files: Array<{ rel: string; size: number; dir: boolean }> = []
  const walk = async (dir: string, rel: string) => {
    const entries = await kernel.readdir(dir)
    if (!entries.length && rel) files.push({ rel: `${rel}/`, size: 0, dir: true })
    for (const e of entries) {
      const full = `${dir === '/' ? '' : dir}/${e.name}`
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir') await walk(full, r)
      else if (e.kind === 'file') files.push({ rel: r, size: (await kernel.stat(full)).size, dir: false })
    }
  }
  await walk(path, '')
  const total = files.reduce((n, f) => n + f.size, 0)
  const soFar = { n: 0 }
  const root = path.slice(path.lastIndexOf('/') + 1) || 'Pear'

  const w = window as unknown as Picker
  if (opts.toHost && w.showDirectoryPicker) {
    const target = await (await w.showDirectoryPicker({ mode: 'readwrite' })).getDirectoryHandle(root, { create: true })
    for (const f of files) {
      const parts = f.rel.split('/').filter(Boolean)
      let dir = target
      for (const p of f.dir ? parts : parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true })
      if (f.dir) continue
      const handle = await dir.getFileHandle(parts[parts.length - 1]!, { create: true })
      await pipeToHandle(handle, await fileBlob(kernel, `${path}/${f.rel}`, opts, total, soFar))
    }
    return
  }
  const zip = new ZipWriter()
  for (const f of files) {
    if (f.dir) zip.add(f.rel, new Blob([]), 0)
    else {
      const blob = await fileBlob(kernel, `${path}/${f.rel}`, opts, total, soFar)
      zip.add(f.rel, blob, await crc32(blob))
    }
  }
  await saveBlob(zip.finish(), `${root}.zip`, opts.saveAs ?? false)
}

// ---------------------------------------------------------------- zip (store only: no compression, no dependency)

class ZipWriter {
  private parts: BlobPart[] = []
  private central: BlobPart[] = []
  private offset = 0
  private count = 0
  private enc = new TextEncoder()

  add(name: string, data: Blob, crc: number): void {
    const n = this.enc.encode(name)
    const h = new DataView(new ArrayBuffer(30))
    h.setUint32(0, 0x04034b50, true)
    h.setUint16(4, 20, true)
    h.setUint16(6, 0x0800, true) // UTF-8 names
    h.setUint32(14, crc, true)
    h.setUint32(18, data.size, true)
    h.setUint32(22, data.size, true)
    h.setUint16(26, n.length, true)
    this.parts.push(h.buffer, n as BlobPart, data)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 20, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, 0x0800, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, data.size, true)
    c.setUint32(24, data.size, true)
    c.setUint16(28, n.length, true)
    c.setUint32(42, this.offset, true)
    this.central.push(c.buffer, n as BlobPart)
    this.offset += 30 + n.length + data.size
    this.count++
  }

  finish(): Blob {
    const size = this.central.reduce((n, p) => n + (p as ArrayBuffer | Uint8Array).byteLength, 0)
    const e = new DataView(new ArrayBuffer(22))
    e.setUint32(0, 0x06054b50, true)
    e.setUint16(8, this.count, true)
    e.setUint16(10, this.count, true)
    e.setUint32(12, size, true)
    e.setUint32(16, this.offset, true)
    return new Blob([...this.parts, ...this.central, e.buffer], { type: 'application/zip' })
  }
}

// ---------------------------------------------------------------- scheduled backups

interface BackupOptions {
  /** Minutes between backups. */
  intervalMinutes: number
  /** A host folder to write into (Chromium), or `'download'` for a browser download. */
  destination: FileSystemDirectoryHandle | 'download'
  /** Encrypt with this passphrase. */
  passphrase?: string
  /** Keep this many files in a folder destination. Default 5. */
  keep?: number
  include?: string[]
  onBackup?: (info: { name: string; size: number }) => void
  onError?: (e: Error) => void
}

/**
 * Take a disk image every `intervalMinutes` while the page is open. The last time is kept in the `tiny.backup` setting
 * so a reload does not restart the clock. Returns a function that stops it.
 */
export function autoBackup(kernel: Kernel, opts: BackupOptions): () => void {
  const every = Math.max(1, opts.intervalMinutes) * 60_000
  let busy = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const run = async () => {
    if (busy) return
    busy = true
    try {
      const blob = await kernel.imageCreate({ include: opts.include, passphrase: opts.passphrase })
      const name = `Pear-${new Date().toISOString().replace(/[:.]/g, '-')}.tinyimg`
      if (opts.destination === 'download') await saveBlob(blob, name, false)
      else {
        const handle = await opts.destination.getFileHandle(name, { create: true })
        await pipeToHandle(handle, blob)
        const old: string[] = []
        for await (const [n] of (opts.destination as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) if (/^Pear-.*\.tinyimg$/.test(n)) old.push(n)
        old.sort()
        for (const n of old.slice(0, Math.max(0, old.length - (opts.keep ?? 5)))) await opts.destination.removeEntry(n).catch(() => {})
      }
      await kernel.configSet('tiny.backup', 'last', Date.now()).catch(() => {})
      opts.onBackup?.({ name, size: blob.size })
    } catch (e) {
      opts.onError?.(e as Error)
    } finally {
      busy = false
    }
  }
  void (async () => {
    const last = Number(await kernel.configGet('tiny.backup', 'last', 0).catch(() => 0))
    const wait = Math.max(0, last + every - Date.now())
    const schedule = (ms: number) => {
      timer = setTimeout(() => void run().then(() => schedule(every)), ms)
    }
    schedule(wait)
  })()
  return () => clearTimeout(timer)
}
