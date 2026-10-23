/**
 * Integration tests for the Vanilla file system running on real OPFS in a
 * real browser Worker. Scenarios run inside the page against the kernel Worker
 * through the same RPC client any process would use.
 */
import { expect, test } from './fixtures'

test('first boot creates the default hierarchy', async ({ page }) => {
  const names = await page.evaluate(async () => (await window.kernel.readdir('/')).map((e) => e.name))
  for (const dir of ['System', 'Applications', 'Users', 'Volumes', 'tmp', 'dev']) expect(names).toContain(dir)
})

test('writes and reads a file, including binary data', async ({ page }) => {
  const ok = await page.evaluate(async () => {
    const k = window.kernel
    const data = new Uint8Array(256).map((_, i) => i)
    await k.writeFile('/tmp/bin', data)
    const back = await k.readFile('/tmp/bin')
    return back.length === 256 && back.every((b, i) => b === i)
  })
  expect(ok).toBe(true)
})

test('handles a multi-megabyte file', async ({ page }) => {
  const ok = await page.evaluate(async () => {
    const k = window.kernel
    const size = 4 * 1024 * 1024
    const data = new Uint8Array(size)
    for (let i = 0; i < size; i++) data[i] = (i * 31) & 0xff
    await k.writeFile('/tmp/big', data)
    const st = await k.stat('/tmp/big')
    const back = await k.readFile('/tmp/big')
    return st.size === size && back.length === size && back.every((b, i) => b === ((i * 31) & 0xff))
  })
  expect(ok).toBe(true)
})

test('file handles: seek, positional io, append', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const RDWR_CREAT = 2 | 0x40
    const fd = await k.open('/tmp/h', RDWR_CREAT)
    await k.write(fd, enc.encode('abcdef'))
    await k.lseek(fd, 2, 0)
    const mid = dec.decode(await k.read(fd, 3))
    const positional = dec.decode(await k.read(fd, 2, 0))
    await k.close(fd)
    const ap = await k.open('/tmp/h', 1 | 0x400)
    await k.write(ap, enc.encode('!'))
    await k.close(ap)
    return { mid, positional, all: dec.decode(await k.readFile('/tmp/h')) }
  })
  expect(out).toEqual({ mid: 'cde', positional: 'ab', all: 'abcdef!' })
})

test('sparse writes are zero-filled', async ({ page }) => {
  const bytes = await page.evaluate(async () => {
    const k = window.kernel
    const fd = await k.open('/tmp/sparse', 2 | 0x40)
    await k.write(fd, new Uint8Array([7]), 5)
    await k.close(fd)
    return Array.from(await k.readFile('/tmp/sparse'))
  })
  expect(bytes).toEqual([0, 0, 0, 0, 0, 7])
})

test('errors carry errno codes', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const k = window.kernel
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
    await k.mkdir('/tmp/d')
    return [
      await code(k.stat('/tmp/missing')),
      await code(k.mkdir('/tmp/d')),
      await code(k.readFile('/tmp')),
      await code(k.rmdir('/tmp/missing')),
    ]
  })
  expect(codes).toEqual(['ENOENT', 'EEXIST', 'EISDIR', 'ENOENT'])
})

test('contents and metadata survive a shutdown and reboot', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const enc = new TextEncoder()
    await k.mkdir('/Users/me/Documents', { recursive: true })
    await k.writeFile('/Users/me/Documents/note.txt', enc.encode('persisted'))
    await k.symlink('/Users/me/Documents/note.txt', '/Users/me/link')
    await k.setxattr('/Users/me/Documents/note.txt', 'tag', 'red')
    await k.shutdown()
    await k.boot({ namespace: ns })
    return {
      text: new TextDecoder().decode(await k.readFile('/Users/me/link')),
      tag: await k.getxattr('/Users/me/Documents/note.txt', 'tag'),
    }
  }, ns)
  expect(out).toEqual({ text: 'persisted', tag: 'red' })
})

test('the background flush reclaims OPFS files of deleted blobs', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const count = async () => {
      const root = await navigator.storage.getDirectory()
      const data = await (await root.getDirectoryHandle(ns)).getDirectoryHandle('data')
      let n = 0
      for await (const _ of data.keys()) n++
      return n
    }
    await k.writeFile('/tmp/doomed', new Uint8Array([1, 2, 3]))
    await k.flush()
    const before = await count()
    await k.unlink('/tmp/doomed')
    // No explicit flush: wait out the debounce so the background one runs.
    await new Promise((r) => setTimeout(r, 800))
    return { before, after: await count() }
  }, ns)
  expect(out.after).toBe(out.before - 1)
})

test('many files: create, list, read back, remove, and reclaim OPFS files', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const N = 300
    await k.mkdir('/tmp/many')
    for (let i = 0; i < N; i++) await k.writeFile(`/tmp/many/f${i}`, new Uint8Array([i & 0xff, 1, 2]))
    const listed = (await k.readdir('/tmp/many')).length
    let good = 0
    for (let i = 0; i < N; i++) if ((await k.readFile(`/tmp/many/f${i}`))[0] === (i & 0xff)) good++
    await k.flush()

    const dataDir = async () => {
      const root = await navigator.storage.getDirectory()
      const base = await root.getDirectoryHandle(ns)
      const data = await base.getDirectoryHandle('data')
      let n = 0
      for await (const _ of data.keys()) n++
      return n
    }
    const before = await dataDir()
    await k.removeAll('/tmp/many')
    await k.flush()
    return { listed, good, before, after: await dataDir() }
  }, ns)
  expect(out.listed).toBe(300)
  expect(out.good).toBe(300)
  expect(out.before).toBeGreaterThanOrEqual(300)
  expect(out.after).toBeLessThan(10)
})

test('more files than the handle cache holds still read back correctly', async ({ page }) => {
  const good = await page.evaluate(async () => {
    const k = window.kernel
    const N = 700 // above the 512 open-handle cap, so older handles are evicted
    await k.mkdir('/tmp/evict')
    for (let i = 0; i < N; i++) await k.writeFile(`/tmp/evict/f${i}`, new Uint8Array([i % 251, i % 7]))
    let ok = 0
    for (let i = 0; i < N; i++) {
      const b = await k.readFile(`/tmp/evict/f${i}`)
      if (b[0] === i % 251 && b[1] === i % 7) ok++
    }
    return ok
  })
  expect(good).toBe(700)
})

test('recursive copy of a directory tree', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    await k.mkdir('/tmp/src/sub', { recursive: true })
    for (let i = 0; i < 40; i++) await k.writeFile(`/tmp/src/sub/f${i}`, enc.encode(`file ${i}`))
    await k.writeFile('/tmp/src/top', enc.encode('top'))
    await k.copy('/tmp/src', '/tmp/dst', { recursive: true })
    // Mutating the source must not affect the copy.
    await k.writeFile('/tmp/src/sub/f7', enc.encode('changed'))
    const dec = new TextDecoder()
    return {
      f7: dec.decode(await k.readFile('/tmp/dst/sub/f7')),
      top: dec.decode(await k.readFile('/tmp/dst/top')),
      count: (await k.readdir('/tmp/dst/sub')).length,
    }
  })
  expect(out).toEqual({ f7: 'file 7', top: 'top', count: 40 })
})

test('atomic write replaces content and leaves no temp files', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    await k.writeFile('/tmp/doc', enc.encode('v1'))
    await k.writeFileAtomic('/tmp/doc', enc.encode('v2'))
    return {
      text: new TextDecoder().decode(await k.readFile('/tmp/doc')),
      names: (await k.readdir('/tmp')).map((e) => e.name),
    }
  })
  expect(out).toEqual({ text: 'v2', names: ['doc'] })
})

test('trash and restore', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    await k.mkdir('/Users/me/Documents', { recursive: true })
    await k.writeFile('/Users/me/Documents/a.txt', new TextEncoder().encode('keep'))
    const trashed = await k.trash('/Users/me/Documents/a.txt', '/Users/me/.Trash')
    const gone = !(await k.exists('/Users/me/Documents/a.txt'))
    const back = await k.restore(trashed)
    return { trashed, gone, back, text: new TextDecoder().decode(await k.readFile(back)) }
  })
  expect(out).toEqual({
    trashed: '/Users/me/.Trash/a.txt',
    gone: true,
    back: '/Users/me/Documents/a.txt',
    text: 'keep',
  })
})

test('change events are delivered', async ({ page }) => {
  const kinds = await page.evaluate(async () => {
    const k = window.kernel
    await k.takeEvents()
    await k.writeFile('/tmp/e', new Uint8Array([1]))
    await k.rename('/tmp/e', '/tmp/e2')
    await k.unlink('/tmp/e2')
    return (await k.takeEvents()).map((e) => `${e.kind}:${e.path}`)
  })
  expect(kinds).toEqual(['created:/tmp/e', 'modified:/tmp/e', 'renamed:/tmp/e2', 'deleted:/tmp/e2'])
})

test('concurrent calls are serialized safely', async ({ page }) => {
  const ok = await page.evaluate(async () => {
    const k = window.kernel
    await k.mkdir('/tmp/par')
    await Promise.all(Array.from({ length: 50 }, (_, i) => k.writeFile(`/tmp/par/f${i}`, new Uint8Array([i]))))
    const reads = await Promise.all(Array.from({ length: 50 }, (_, i) => k.readFile(`/tmp/par/f${i}`)))
    return reads.every((b, i) => b[0] === i)
  })
  expect(ok).toBe(true)
})
