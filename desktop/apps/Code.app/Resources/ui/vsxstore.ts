// The extension manager's storage (contracts/code-extensions.md): installed extensions are plain
// files in the VFS, listed in extensions.json. Install verifies and unpacks into a staging
// directory, then moves it into place with one rename; no extension code runs during install.
import { dirname, joinPath, tiny } from '@tiny/sdk'
import {
  VsxError,
  checkRunnable,
  downloadListing,
  engineWarning,
  entryCandidates,
  extId,
  findRoot,
  folderName,
  lookupOpenVsx,
  MAX_BYTES,
  normalize,
  parseManifest,
  readZip,
  searchOpenVsx,
  sha256Hex,
  webCompat,
  type Listing,
  type Runnable,
  type VsxManifest,
} from './vsx'

export type Source =
  | { kind: 'registry'; url: string; digest: string; verified: boolean }
  | { kind: 'vsix'; digest: string }
  | { kind: 'folder'; path: string }

export interface Installed {
  id: string
  version: string
  /** Absolute directory holding package.json (for a dev folder, the folder itself). */
  dir: string
  source: Source
  enabled: boolean
  installedAt: string
  /** True for registry installs (Open VSX signs and verifies namespaces); sideloads and dev folders are unsigned. */
  signed: boolean
  kind: 'declarative' | 'web'
  warning?: string
  manifest: VsxManifest
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Wait until download `id` has written everything to `dest`; a failed download removes its file, which is reported as `EIO`. */
async function finishedDownload(id: number, dest: string, total: number | null): Promise<void> {
  const deadline = Date.now() + 10 * 60_000
  let last = -1
  let steady = 0
  while (Date.now() < deadline) {
    const active = ((await tiny.service<Array<{ id: number }>>('tiny.network', { op: 'downloads' })) ?? []).some((d) => d.id === id)
    let size = -1
    try {
      size = (await tiny.stat(dest)).size
    } catch {
      if (!active) throw new VsxError('The download did not complete.', 'EIO')
    }
    if (!active) {
      // the service forgets a download just before its last queued writes land
      if (total !== null ? size >= total : size === last && ++steady >= 2) return
      if (total === null && size !== last) steady = 0
    }
    last = size
    await sleep(120)
  }
  throw new VsxError('The download timed out.', 'ETIMEDOUT')
}

/** Stream a package to the app's own container, then read it back; the file is removed either way. */
async function downloadBytes(url: string): Promise<Uint8Array> {
  const home = (await tiny.getenv('HOME')) || '/Users/pear'
  const dir = joinPath(home, 'Library/Containers/org.tiny.code/tmp')
  await tiny.mkdir(dir, { recursive: true })
  const dest = joinPath(dir, `dl-${Date.now().toString(36)}.vsix`)
  try {
    try {
      // `download` answers when the response starts, not when the file is complete: wait for the last byte
      const started = await tiny.net.download(url, dest)
      await finishedDownload(started.id, dest, started.total)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      throw new VsxError(`Could not download the extension: ${err.message ?? e}`, err.code ?? 'EIO')
    }
    const size = (await tiny.stat(dest)).size
    if (size > MAX_BYTES) throw new VsxError(`The download is larger than ${MAX_BYTES / 1024 / 1024} MB.`, 'ENOSPC')
    return await tiny.readFile(dest)
  } finally {
    await tiny.removeAll(dest).catch(() => {})
  }
}

const registryFetch = (url: string, init?: { timeout?: number }): Promise<Response> => tiny.net.fetch(url, init)

let rootDir: string | null = null
async function root(): Promise<string> {
  if (!rootDir) {
    const home = (await tiny.getenv('HOME')) || '/Users/pear'
    rootDir = joinPath(home, 'Library/Application Support/Code/extensions')
  }
  return rootDir
}

/** Where an extension may write: its own storage folder (globalStorage), created on first use. */
export async function storageDir(id: string): Promise<string> {
  const dir = joinPath(dirname(await root()), `globalStorage/${id}`)
  await tiny.mkdir(dir, { recursive: true })
  return dir
}

/** The installed list. Only a missing file means "none yet": any other failure throws, so a hiccup can never be saved over the real list. */
async function readIndex(): Promise<Installed[]> {
  const file = joinPath(await root(), 'extensions.json')
  let text: string
  try {
    text = new TextDecoder().decode(await tiny.readFile(file))
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return []
    throw e
  }
  const parsed = JSON.parse(text) as unknown
  return Array.isArray(parsed) ? (parsed as Installed[]) : []
}

/** Changes to the list run one at a time, each reading the list as the previous one left it (two installs can overlap). */
let queue: Promise<unknown> = Promise.resolve()
const mutate = <T>(fn: (index: Installed[]) => Promise<{ index: Installed[]; result: T }>): Promise<T> => {
  const run = queue.then(async () => {
    const { index, result } = await fn(await readIndex())
    await writeIndex(index)
    return result
  })
  queue = run.catch(() => {})
  return run
}

async function writeIndex(list: Installed[]): Promise<void> {
  const dir = await root()
  await tiny.mkdir(dir, { recursive: true })
  await tiny.writeFileAtomic(joinPath(dir, 'extensions.json'), new TextEncoder().encode(JSON.stringify(list, null, 2)))
}

async function anyExists(paths: string[]): Promise<boolean> {
  for (const p of paths) if (await tiny.exists(p)) return true
  return false
}

/** The source of an extension's browser entry (resolving a missing `.js`). */
export async function readEntry(ext: Installed): Promise<string> {
  let error: unknown
  for (const c of entryCandidates(ext.manifest.browser!)) {
    try {
      return await readExtText(ext, c)
    } catch (e) {
      error = e
    }
  }
  throw error
}

export const list = readIndex

const listeners = new Set<() => void>()
/** Called after any install, removal, update or enable change. */
export const onChange = (fn: () => void): (() => void) => (listeners.add(fn), () => listeners.delete(fn))
const changed = (): void => listeners.forEach((fn) => fn())

export async function readExtFile(ext: Installed, rel: string): Promise<Uint8Array> {
  const clean = normalize(rel)
  if (!clean || clean.split('/').includes('..')) throw new VsxError(`Path outside the extension: ${rel}`, 'EINVAL')
  return tiny.readFile(joinPath(ext.dir, clean))
}

export const readExtText = async (ext: Installed, rel: string): Promise<string> => new TextDecoder().decode(await readExtFile(ext, rel))

export interface Review {
  manifest: VsxManifest
  id: string
  kind: 'declarative' | 'web'
  files: number
  bytes: number
  warning: string | null
  unsigned: boolean
}

/** Everything the install review shows, from the package alone. Throws `EINVAL` when the extension cannot run here. */
export async function inspect(bytes: Uint8Array): Promise<{ review: Review; files: Map<string, Uint8Array>; prefix: string }> {
  const files = await readZip(bytes)
  const prefix = findRoot(files)
  const manifest = parseManifest(new TextDecoder().decode(files.get(prefix + 'package.json')!))
  const compat = webCompat(manifest)
  if (!compat.ok) throw new VsxError(compat.reason, 'EINVAL')
  if (manifest.browser && !entryCandidates(manifest.browser).some((c) => files.has(prefix + c))) throw new VsxError(`The browser entry ${manifest.browser} is missing from the package.`, 'EINVAL')
  let total = 0
  for (const [, b] of files) total += b.length
  return { files, prefix, review: { manifest, id: extId(manifest), kind: compat.kind, files: files.size, bytes: total, warning: engineWarning(manifest), unsigned: true } }
}

/** Unpack a verified package into the install directory and record it. Replaces an older version of the same extension (storage is kept). */
export interface InstallOptions {
  enable?: boolean
  /** The install review: called with what was verified, before anything is written. Return false to cancel (nothing is installed). */
  confirm?: (review: Review, source: Source) => Promise<boolean>
}

export async function installPackage(bytes: Uint8Array, source: Source, opts: InstallOptions = {}): Promise<Installed | null> {
  const { review, files, prefix } = await inspect(bytes)
  if (opts.confirm && !(await opts.confirm({ ...review, unsigned: source.kind !== 'registry' }, source))) return null
  const base = await root()
  const stage = joinPath(base, `.staging-${Date.now().toString(36)}`)
  const final = joinPath(base, folderName(review.manifest))
  try {
    for (const [path, data] of files) {
      if (!path.startsWith(prefix)) continue
      const dest = joinPath(stage, path.slice(prefix.length))
      await tiny.mkdir(dirname(dest), { recursive: true })
      await tiny.writeFile(dest, data)
    }
    if (await tiny.exists(final)) await tiny.removeAll(final)
    await tiny.rename(stage, final)
  } catch (e) {
    await tiny.removeAll(stage).catch(() => {})
    throw e
  }
  const record: Installed = {
    id: review.id,
    version: review.manifest.version,
    dir: final,
    source,
    enabled: opts.enable !== false,
    installedAt: new Date().toISOString(),
    signed: source.kind === 'registry',
    kind: review.kind,
    ...(review.warning ? { warning: review.warning } : {}),
    manifest: review.manifest,
  }
  await mutate(async (index) => {
    for (const old of index.filter((e) => e.id === record.id && e.dir !== final && e.source.kind !== 'folder')) await tiny.removeAll(old.dir).catch(() => {})
    return { index: [...index.filter((e) => e.id !== record.id), record], result: null }
  })
  changed()
  return record
}

/** Install from Open VSX by id (latest or a given version). `expectDigest` pins the exact bytes. */
export async function installFromRegistry(l: Listing, opts: InstallOptions & { expectDigest?: string } = {}): Promise<Installed | null> {
  const { bytes, digest } = await downloadListing(registryFetch, downloadBytes, l)
  if (opts.expectDigest && opts.expectDigest !== digest) throw new VsxError('The download is not the package that was pinned.', 'EINVAL')
  return installPackage(bytes, { kind: 'registry', url: l.downloadUrl, digest, verified: l.verified }, opts)
}

export async function installVsix(path: string, opts: InstallOptions = {}): Promise<Installed | null> {
  const bytes = await tiny.readFile(path)
  return installPackage(bytes, { kind: 'vsix', digest: await sha256Hex(bytes) }, opts)
}

/** Load an extension folder in place ("Install Extension From Location"). Nothing is copied. */
export async function installFolder(path: string): Promise<Installed> {
  let text: string
  try {
    text = new TextDecoder().decode(await tiny.readFile(joinPath(path, 'package.json')))
  } catch {
    throw new VsxError('No package.json in that folder.', 'ENOENT')
  }
  const manifest = parseManifest(text)
  const compat = webCompat(manifest)
  if (!compat.ok) throw new VsxError(compat.reason, 'EINVAL')
  if (manifest.browser && !(await anyExists(entryCandidates(manifest.browser).map((c) => joinPath(path, c))))) throw new VsxError(`The browser entry ${manifest.browser} is missing.`, 'EINVAL')
  const warning = engineWarning(manifest)
  const record: Installed = {
    id: extId(manifest),
    version: manifest.version,
    dir: path,
    source: { kind: 'folder', path },
    enabled: true,
    installedAt: new Date().toISOString(),
    signed: false,
    kind: compat.kind,
    ...(warning ? { warning } : {}),
    manifest,
  }
  await mutate(async (index) => ({ index: [...index.filter((e) => e.id !== record.id), record], result: null }))
  changed()
  return record
}

export async function setEnabled(id: string, enabled: boolean): Promise<void> {
  await mutate(async (index) => ({ index: index.map((e) => (e.id === id ? { ...e, enabled } : e)), result: null }))
  changed()
}

export async function uninstall(id: string, opts: { deleteData?: boolean } = {}): Promise<void> {
  await mutate(async (index) => {
    const ext = index.find((e) => e.id === id)
    if (!ext) throw new VsxError(`${id} is not installed.`, 'ENOENT')
    if (ext.source.kind !== 'folder') await tiny.removeAll(ext.dir).catch(() => {}) // a dev folder is the person's own: never deleted
    if (opts.deleteData) await tiny.removeAll(joinPath(dirname(await root()), `globalStorage/${id}`)).catch(() => {})
    return { index: index.filter((e) => e.id !== id), result: null }
  })
  changed()
}

/** A newer version from the recorded registry source, or null when up to date / not from a registry. */
export async function checkUpdate(ext: Installed): Promise<Listing | null> {
  if (ext.source.kind !== 'registry') return null
  const latest = await lookupOpenVsx(registryFetch, ext.id).catch(() => null)
  return latest && latest.version !== ext.version ? latest : null
}

export async function update(id: string): Promise<Installed | null> {
  const ext = (await readIndex()).find((e) => e.id === id)
  const latest = ext ? await checkUpdate(ext) : null
  return latest ? installFromRegistry(latest, { enable: ext!.enabled }) : null
}

const runnableCache = new Map<string, Promise<Runnable>>()
/** Whether a marketplace listing can run in the browser (cached per version). */
export const runnable = (l: Listing): Promise<Runnable> => {
  const key = `${l.id}@${l.version}`
  let p = runnableCache.get(key)
  if (!p) runnableCache.set(key, (p = checkRunnable(registryFetch, l)))
  return p
}

/** The full marketplace record for an extension (readme link, categories, rating...), or null when it is not published or unreachable. */
export const lookup = (id: string): Promise<Listing | null> => lookupOpenVsx(registryFetch, id).catch(() => null)

/** Open VSX search; an empty query lists the most downloaded extensions. */
export const search = (query: string): Promise<Listing[]> => searchOpenVsx(registryFetch, query, undefined, 30, query ? 'relevance' : 'downloadCount')
