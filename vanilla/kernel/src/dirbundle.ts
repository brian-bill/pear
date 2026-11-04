/// A bundle served as a directory (`manifest.json` and the files it lists): fetched, and checked against hashes before
/// anything is handed on. Used by `tiny.sources` (a registry's `directory` artifact) and `tiny.installer` (a link to a
/// served directory). `get` and `sha256` come from the caller: a sandboxed process has neither `fetch` nor `crypto.subtle`.
import { SysError } from './errors'
import { resolveUrl } from './sources'

export const MAX_DIRECTORY_FILES = 500
export const MAX_DIRECTORY_BYTES = 64 * 1024 * 1024
const dec = new TextDecoder()
const fail = (code: string, message: string) => new SysError(code, message)

export interface Fetched {
  status: number
  body: Uint8Array
}
export type Get = (url: string, accept: string) => Promise<Fetched>

const safePath = (p: string) => p.length > 0 && p.length < 256 && !p.startsWith('/') && !p.includes('\\') && !p.includes('\0') && !p.split('/').some((s) => s === '' || s === '.' || s === '..')

export interface DirectoryExpect {
  /** SHA-256 the `manifest.json` must have: pins every file, since the manifest hashes them. */
  manifestDigest?: string
  id?: string
  version?: string
  /** The manifest may ask for these permissions and no others. */
  permissions?: string[]
}

/**
 * Every file the manifest hashes, each checked. A bundle with no `hashes` is refused (`EPERM`): fetching files nobody
 * vouched for is exactly what the bare-manifest rule forbids. The entry must be among the hashed files.
 */
export async function fetchDirectory(
  get: Get,
  sha256: (data: Uint8Array) => Promise<string>,
  base: string,
  expect: DirectoryExpect = {},
): Promise<{ files: Record<string, Uint8Array>; manifest: Record<string, any>; manifestDigest: string }> {
  base = base.replace(/\/+$/, '')
  const m = await get(`${base}/manifest.json`, 'application/json')
  if (m.status !== 200) throw fail('EIO', `manifest.json answered ${m.status}`)
  const manifestDigest = await sha256(m.body)
  if (expect.manifestDigest && manifestDigest !== expect.manifestDigest) throw fail('EINVAL', 'manifest.json does not match the digest that was published')
  let manifest: Record<string, any>
  try {
    manifest = JSON.parse(dec.decode(m.body))
  } catch {
    throw fail('EINVAL', 'manifest.json is not valid JSON')
  }
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) throw fail('EINVAL', 'manifest.json must be an object')
  if (expect.id !== undefined && manifest.id !== expect.id) throw fail('EINVAL', `the bundle says it is ${String(manifest.id)}, not ${expect.id}`)
  if (expect.version !== undefined && manifest.version !== expect.version) throw fail('EINVAL', `the bundle says it is version ${String(manifest.version)}, not ${expect.version}`)
  if (expect.permissions) {
    const extra = (Array.isArray(manifest.permissions) ? (manifest.permissions as string[]) : []).filter((p) => !expect.permissions!.includes(p))
    if (extra.length) throw fail('EINVAL', `the bundle asks for permissions its listing does not show: ${extra.join(', ')}`)
  }
  const hashes = manifest.hashes
  if (typeof hashes !== 'object' || hashes === null || Array.isArray(hashes)) {
    throw fail('EPERM', 'a bundle served as a directory must list "hashes" for every file in its manifest; one without is not installed from a link')
  }
  const entries = Object.entries(hashes as Record<string, unknown>)
  if (entries.length === 0 || entries.length > MAX_DIRECTORY_FILES) throw fail('EINVAL', `a bundle needs between 1 and ${MAX_DIRECTORY_FILES} hashed files`)
  const entry = typeof manifest.entry === 'string' ? manifest.entry : 'main.js'
  if (!(entry in (hashes as object))) throw fail('EINVAL', 'the entry file must be listed in "hashes"')
  for (const [p, h] of entries) if (!safePath(p) || typeof h !== 'string' || !/^[0-9a-f]{64}$/i.test(h)) throw fail('EINVAL', `bad hash entry for "${p}"`)

  const files: Record<string, Uint8Array> = { 'manifest.json': m.body }
  let total = m.body.length
  let next = 0
  const worker = async () => {
    while (next < entries.length) {
      const [p, h] = entries[next++] as [string, string]
      if (p === 'manifest.json') continue
      const res = await get(resolveUrl(p.split('/').map(encodeURIComponent).join('/'), `${base}/`, `file ${p}`), '*/*')
      if (res.status !== 200) throw fail('EIO', `${p} answered ${res.status}`)
      total += res.body.length
      if (total > MAX_DIRECTORY_BYTES) throw fail('ENOSPC', 'the bundle is larger than 64 MB')
      if ((await sha256(res.body)) !== h.toLowerCase()) throw fail('EINVAL', `${p} does not match its hash`)
      files[p] = res.body
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return { files, manifest, manifestDigest }
}
