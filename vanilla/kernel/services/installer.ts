import { fail, needSystem, serve } from './lib'
import type { Pear } from '../src/runtime'
import { fetchDirectory } from '../src/dirbundle'
import { checkUrl } from '../src/sources'

const MAGIC = 'PEARAPP\0'
const MAX_PACKAGE = 80 * 1024 * 1024
const TIMEOUT = 30_000

/**
 * `tiny.installer`: fetch what a link points at, and check it, for the Desktop's install prompt
 * (`contracts/app-distribution.md`). A `.pearapp` comes back as bytes (the kernel verifies it when it is installed); a
 * served directory comes back as its files, every one checked against the manifest's hashes. Nothing is installed here:
 * a process cannot install bundles, and the prompt has to come first. System only.
 */
export default async (tiny: Pear) => {
  const sha256 = (data: Uint8Array) => tiny.cryptoDigest(data)

  const get = async (url: string, accept: string): Promise<{ status: number; headers: Record<string, string>; body: Uint8Array }> => {
    const port = await tiny.lookup('tiny.network')
    const reply = (await tiny.request(port, { op: 'fetch', url, init: { headers: { accept }, credentials: 'omit' }, timeout: TIMEOUT }, { timeout: TIMEOUT + 5000 })).data as {
      ok: boolean
      result?: { status: number; headers: Record<string, string>; body: Uint8Array }
      error?: { code: string; message: string }
    }
    if (!reply.ok) throw fail(reply.error?.code ?? 'EIO', reply.error?.message ?? 'the request failed')
    return reply.result!
  }

  return serve(tiny, 'tiny.installer', {
    /**
     * `{url, digest?}` -> `{kind: 'archive', url, bytes, digest}` or `{kind: 'directory', url, files, manifestDigest, unsigned: true}`.
     * A path ending in `.pearapp` is an image; anything else is a served directory (a trailing `manifest.json` is fine).
     */
    fetch: async (a, m) => {
      await needSystem(tiny, m, 'install from a link')
      let url: URL
      try {
        url = new URL(String(a.url))
      } catch {
        throw fail('EINVAL', 'that is not a valid address')
      }
      try {
        checkUrl(url, 'the link')
      } catch (e) {
        throw fail((e as { code?: string }).code ?? 'EPERM', (e as Error).message)
      }
      url.hash = ''
      if (/\.pearapp$/i.test(url.pathname)) {
        const res = await get(url.href, 'application/vnd.pear.app, application/octet-stream')
        if (res.status === 404) throw fail('ENOENT', 'the link points to nothing (404)')
        if (res.status !== 200) throw fail('EIO', `the server answered ${res.status}`)
        if (res.body.length > MAX_PACKAGE) throw fail('ENOSPC', 'the package is larger than allowed')
        if (new TextDecoder().decode(res.body.subarray(0, MAGIC.length)) !== MAGIC) throw fail('EINVAL', 'the link does not point to a Pear app package')
        const digest = await sha256(res.body)
        if (typeof a.digest === 'string' && a.digest.toLowerCase() !== digest) throw fail('EINVAL', 'the package is not the one that was expected (digest mismatch)')
        return { kind: 'archive', url: url.href, bytes: res.body, digest }
      }
      const base = new URL(url.href)
      base.search = ''
      base.pathname = base.pathname.replace(/\/manifest\.json$/, '').replace(/\/+$/, '')
      const { files, manifestDigest } = await fetchDirectory(async (u, accept) => {
        const r = await get(u, accept)
        return { status: r.status, body: r.body }
      }, sha256, base.href, { manifestDigest: typeof a.digest === 'string' ? a.digest.toLowerCase() : undefined })
      return { kind: 'directory', url: base.href, files, manifestDigest, unsigned: true }
    },
  })
}
