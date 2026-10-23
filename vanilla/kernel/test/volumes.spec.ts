/** Host volumes, advisory locks and bookmarks. A host folder is stood in for by an OPFS directory handle. */
import { expect, test } from './fixtures'

declare global {
  interface Window {
    hostDir(name: string): Promise<FileSystemDirectoryHandle>
  }
}

test.beforeEach(async ({ page }) => {
  await page.evaluate(() => {
    window.hostDir = async (name: string) => {
      const root = await navigator.storage.getDirectory()
      return root.getDirectoryHandle(`host-${name}`, { create: true })
    }
  })
})
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    for await (const [name] of root.entries()) if (name.startsWith('host-')) await root.removeEntry(name, { recursive: true })
  })
})

test('a mounted host folder reads, writes and lists like any folder', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const h = await window.hostDir(ns)
    const sub = await h.getDirectoryHandle('docs', { create: true })
    const f = await (await sub.getFileHandle('a.txt', { create: true })).createWritable()
    await f.write('from the host')
    await f.close()

    await k.mount(h, '/Volumes/Host')
    const events: string[] = []
    k.onEvent((e) => e.type === 'volume' && events.push(`${e.event}:${e.point}`))
    const res: Record<string, unknown> = {}
    res.root = (await k.readdir('/Volumes')).map((e) => e.name)
    res.list = (await k.readdir('/Volumes/Host')).map((e) => `${e.name}:${e.kind}`)
    res.read = dec.decode(await k.readFile('/Volumes/Host/docs/a.txt'))
    const st = await k.stat('/Volumes/Host/docs/a.txt')
    res.stat = [st.kind, st.size, st.mode.toString(8), st.uid]
    res.dirStat = (await k.stat('/Volumes/Host/docs')).kind

    await k.writeFile('/Volumes/Host/docs/b.txt', enc.encode('written in Pear'))
    await k.mkdir('/Volumes/Host/x/y/z', { recursive: true })
    await k.rename('/Volumes/Host/docs/b.txt', '/Volumes/Host/x/b2.txt')
    await k.copy('/Volumes/Host/x', '/Volumes/Host/x-copy', { recursive: true })
    await k.unlink('/Volumes/Host/docs/a.txt')
    res.after = [
      (await k.readdir('/Volumes/Host')).map((e) => e.name),
      (await k.readdir('/Volumes/Host/x-copy')).map((e) => e.name),
      dec.decode(await k.readFile('/Volumes/Host/x-copy/b2.txt')),
      await k.exists('/Volumes/Host/docs/a.txt'),
      await k.exists('/Volumes/Host/docs/b.txt'),
    ]
    // what the host folder really holds
    const real = await (await (await h.getDirectoryHandle('x')).getFileHandle('b2.txt')).getFile()
    res.host = await real.text()
    res.err = await k.readFile('/Volumes/Host/nope').catch((e) => e.code)
    res.err2 = await k.readdir('/Volumes/Host/x/b2.txt').catch((e) => e.code)
    res.err3 = await k.rmdir('/Volumes/Host/x').catch((e) => e.code)
    res.err4 = await k.mkdir('/Volumes/Host/x').catch((e) => e.code)
    res.err5 = await k.symlink('a', '/Volumes/Host/ln').catch((e) => e.code)
    // paths with .. are routed on what they mean
    res.dots = dec.decode(await k.readFile('/Volumes/Host/x/../x/b2.txt'))
    res.mounts = await k.mounts()
    await k.unmount('/Volumes/Host')
    res.gone = [await k.readdir('/Volumes/Host'), events]
    return res
  }, ns)
  expect(out.root).toEqual(['Host'])
  expect(out.list).toEqual(['docs:dir'])
  expect(out.read).toBe('from the host')
  expect(out.stat).toEqual(['file', 13, '644', 501])
  expect(out.dirStat).toBe('dir')
  expect(out.after).toEqual([['docs', 'x', 'x-copy'], ['b2.txt', 'y'], 'written in Pear', false, false])
  expect(out.host).toBe('written in Pear')
  expect(out.err).toBe('ENOENT')
  expect(out.err2).toBe('ENOTDIR')
  expect(out.err3).toBe('ENOTEMPTY')
  expect(out.err4).toBe('EEXIST')
  expect(out.err5).toBe('ENOSYS')
  expect(out.dots).toBe('written in Pear')
  expect(out.mounts).toMatchObject([{ point: '/Volumes/Host', readOnly: false, open: 0 }])
  expect(out.gone).toEqual([[], ['unmounted:/Volumes/Host']])
})

test('handles on a host volume: seek, append, truncate, write-back on close', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const h = await window.hostDir(ns)
    await k.mount(h, '/Volumes/H')
    const O = { RDONLY: 0, WRONLY: 1, RDWR: 2, CREAT: 0x40, EXCL: 0x80, TRUNC: 0x200, APPEND: 0x400 }
    const res: Record<string, unknown> = {}
    const fd = await k.open('/Volumes/H/f', O.RDWR | O.CREAT)
    await k.write(fd, enc.encode('hello world'))
    await k.lseek(fd, 6, 0)
    res.read = dec.decode(await k.read(fd, 5))
    await k.write(fd, enc.encode('HELLO'), 0)
    res.size = (await k.fstat(fd)).size
    await k.ftruncate(fd, 8)
    // not on the host until it is closed
    const f = await h.getFileHandle('f')
    res.before = await (await f.getFile()).text()
    await k.close(fd)
    res.after = await (await f.getFile()).text()
    const a = await k.open('/Volumes/H/f', O.WRONLY | O.APPEND)
    await k.write(a, enc.encode('++'))
    await k.close(a)
    res.appended = dec.decode(await k.readFile('/Volumes/H/f'))
    res.excl = await k.open('/Volumes/H/f', O.WRONLY | O.CREAT | O.EXCL).catch((e) => e.code)
    res.wr = await (async () => {
      const r = await k.open('/Volumes/H/f', O.RDONLY)
      const e = await k.write(r, enc.encode('x')).catch((e) => e.code)
      await k.close(r)
      return e
    })()
    res.dir = await k.open('/Volumes/H', O.RDONLY).catch((e) => e.code)
    res.badfd = await k.read((1 << 28) + 999, 1).catch((e) => e.code)
    await k.truncate('/Volumes/H/f', 3)
    res.trunc = dec.decode(await k.readFile('/Volumes/H/f'))
    return res
  }, ns)
  expect(out).toEqual({
    read: 'world', size: 11, before: '', after: 'HELLO wo', appended: 'HELLO wo++', excl: 'EEXIST', wr: 'EBADF', dir: 'EISDIR', badfd: 'EBADF', trunc: 'HEL',
  })
})

test('read-only mounts, unmount rules and mount point rules', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const enc = new TextEncoder()
    const h = await window.hostDir(ns)
    await (await (await h.getFileHandle('keep', { create: true })).createWritable().then(async (w) => (await w.write('1'), w.close())))
    const res: Record<string, unknown> = {}
    await k.mkdir('/Volumes/Full', { recursive: true })
    await k.writeFile('/Volumes/Full/x', enc.encode('x'))
    res.nonEmpty = await k.mount(h, '/Volumes/Full').catch((e) => e.code)
    res.relative = await k.mount(h, 'Volumes/R').catch((e) => e.code)
    res.root = await k.mount(h, '/').catch((e) => e.code)
    await k.mount(h, '/Volumes/RO', { readOnly: true })
    res.roStat = (await k.stat('/Volumes/RO/keep')).mode.toString(8)
    res.roWrite = await k.writeFile('/Volumes/RO/new', enc.encode('x')).catch((e) => e.code)
    res.roUnlink = await k.unlink('/Volumes/RO/keep').catch((e) => e.code)
    res.roMkdir = await k.mkdir('/Volumes/RO/d').catch((e) => e.code)
    res.roRead = (await k.readFile('/Volumes/RO/keep')).length
    res.twice = await k.mount(h, '/Volumes/RO').catch((e) => e.code)
    res.nested = await k.mount(h, '/Volumes/RO/inner').catch((e) => e.code)
    res.above = await k.mount(h, '/Volumes').catch((e) => e.code)
    res.rmMount = await k.removeAll('/Volumes').catch((e) => e.code)
    res.rmMount2 = await k.rmdir('/Volumes/RO').catch((e) => e.code)
    res.mvMount = await k.rename('/Volumes/RO', '/Volumes/RO2').catch((e) => e.code)
    const fd = await k.open('/Volumes/RO/keep', 0)
    res.busy = await k.unmount('/Volumes/RO').catch((e) => e.code)
    await k.unmount('/Volumes/RO', { force: true })
    res.fdAfter = await k.read(fd, 1).catch((e) => e.code)
    res.notMounted = await k.unmount('/Volumes/RO').catch((e) => e.code)
    res.dirLeft = (await k.stat('/Volumes/RO')).kind
    return res
  }, ns)
  expect(out).toEqual({
    nonEmpty: 'ENOTEMPTY', relative: 'EINVAL', root: 'EINVAL', roStat: '444', roWrite: 'EROFS', roUnlink: 'EROFS', roMkdir: 'EROFS', roRead: 1,
    twice: 'EBUSY', nested: 'EBUSY', above: 'EBUSY', rmMount: 'EBUSY', rmMount2: 'EBUSY', mvMount: 'EBUSY', busy: 'EBUSY',
    fdAfter: 'EBADF', notMounted: 'EINVAL', dirLeft: 'dir',
  })
})

test('copy and move between the VFS and a host volume', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    const h = await window.hostDir(ns)
    await k.mount(h, '/Volumes/H')
    await k.mkdir('/tmp/src/sub', { recursive: true })
    await k.writeFile('/tmp/src/a', enc.encode('A'))
    await k.writeFile('/tmp/src/sub/b', enc.encode('B'))
    const res: Record<string, unknown> = {}
    await k.copy('/tmp/src', '/Volumes/H/src', { recursive: true })
    res.host = [(await k.readdir('/Volumes/H/src')).map((e) => e.name), dec.decode(await k.readFile('/Volumes/H/src/sub/b'))]
    res.srcStays = await k.exists('/tmp/src/a')
    res.shallow = await k.copy('/tmp/src', '/Volumes/H/shallow').catch((e) => e.code)
    await k.rename('/Volumes/H/src', '/tmp/moved')
    res.moved = [await k.exists('/Volumes/H/src'), dec.decode(await k.readFile('/tmp/moved/sub/b'))]
    await k.writeFile('/Volumes/H/one', enc.encode('one'))
    await k.copy('/Volumes/H/one', '/tmp/one')
    res.back = dec.decode(await k.readFile('/tmp/one'))
    res.exists = await k.copy('/tmp/one', '/Volumes/H/one').catch((e) => e.code)
    res.trash = await k.trash('/Volumes/H/one', '/tmp').catch((e) => e.code)
    const events = (await k.takeEvents()).filter((e) => e.path.startsWith('/Volumes/H')).map((e) => `${e.kind}:${e.path}`)
    res.events = events.includes('created:/Volumes/H/one')
    return res
  }, ns)
  expect(out).toEqual({
    host: [['a', 'sub'], 'B'], srcStays: true, shallow: 'EISDIR', moved: [false, 'B'], back: 'one', exists: 'EEXIST', trash: 'ENOSYS', events: true,
  })
})

test('flock: shared, exclusive, non-blocking, waiting, timeout, release on close', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    await k.writeFile('/tmp/lock', enc.encode('x'))
    const open = () => k.open('/tmp/lock', 2)
    const [a, b, c] = [await open(), await open(), await open()]
    const res: Record<string, unknown> = {}
    await k.flock(a, 'sh')
    await k.flock(b, 'sh')
    res.twoShared = true
    res.exNb = await k.flock(c, 'ex', { nonblock: true }).catch((e) => e.code)
    res.upgradeNb = await k.flock(a, 'ex', { nonblock: true }).catch((e) => e.code)
    await k.flock(b, 'un')
    await k.flock(a, 'ex', { nonblock: true }) // alone now: upgrade works
    res.shNb = await k.flock(b, 'sh', { nonblock: true }).catch((e) => e.code)
    res.timeout = await k.flock(b, 'sh', { timeout: 50 }).catch((e) => e.code)

    // a waiter is woken by the holder letting go, in order
    const order: string[] = []
    const w1 = k.flock(b, 'ex').then(() => order.push('b'))
    const w2 = k.flock(c, 'ex').then(() => order.push('c'))
    await new Promise((r) => setTimeout(r, 50))
    res.waiting = order.slice()
    await k.flock(a, 'un')
    await w1
    res.afterUnlock = order.slice()
    await k.close(b) // closing releases
    await w2
    res.afterClose = order.slice()
    // a descriptor closed while waiting fails its wait
    const d = await open()
    const waitD = k.flock(d, 'sh').catch((e) => e.code)
    await new Promise((r) => setTimeout(r, 20))
    await k.close(d)
    res.closedWaiting = await waitD
    res.badfd = await k.flock(9999, 'ex').catch((e) => e.code)
    res.badop = await k.flock(c, 'bogus' as 'ex').catch((e) => e.code)
    // a different file is independent
    await k.writeFile('/tmp/other', enc.encode('x'))
    const o = await k.open('/tmp/other', 2)
    await k.flock(o, 'ex', { nonblock: true })
    res.independent = true
    return res
  })
  expect(out).toEqual({
    twoShared: true, exNb: 'EAGAIN', upgradeNb: 'EAGAIN', shNb: 'EAGAIN', timeout: 'ETIMEDOUT', waiting: [],
    afterUnlock: ['b'], afterClose: ['b', 'c'], closedWaiting: 'EBADF', badfd: 'EBADF', badop: 'EINVAL', independent: true,
  })
})

test('flock between processes, released when the holder exits; and on host volumes', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { kernel: k, sh } = window
    const enc = new TextEncoder()
    await k.writeFile('/tmp/shared', enc.encode('x'))
    await sh.install('/tmp/holder.js', `export default async (tiny) => {
      const fd = await tiny.open('/tmp/shared', 2)
      await tiny.flock(fd, 'ex')
      await tiny.writeFile('/tmp/holding', new Uint8Array(1))
      await tiny.receive(await tiny.portCreate(), { timeout: 600 }).catch(() => {}) // hold it for a while, then just exit
    }`)
    await sh.install('/tmp/waiter.js', `export default async (tiny) => {
      const fd = await tiny.open('/tmp/shared', 2)
      const t = Date.now()
      const nb = await tiny.flock(fd, 'ex', { nonblock: true }).catch((e) => e.code)
      await tiny.flock(fd, 'ex')
      await tiny.writeFile('/tmp/waited', new TextEncoder().encode(nb + ':' + (Date.now() - t >= 300)))
    }`)
    const holder = await k.spawn('/tmp/holder.js')
    await sh.waitFor('/tmp/holding')
    const waiter = await k.spawn('/tmp/waiter.js')
    const early = await k.exists('/tmp/waited')
    await k.wait(holder)
    const st = await k.wait(waiter)
    const res: Record<string, unknown> = { early, waited: await sh.cat('/tmp/waited'), code: st.code }

    const h = await window.hostDir(ns)
    await k.mount(h, '/Volumes/L')
    const a = await k.open('/Volumes/L/f', 0x42)
    const b = await k.open('/Volumes/L/f', 2)
    await k.flock(a, 'ex')
    res.host = await k.flock(b, 'sh', { nonblock: true }).catch((e) => e.code)
    await k.unmount('/Volumes/L', { force: true })
    return res
  }, ns)
  expect(out).toEqual({ early: false, waited: 'EAGAIN:true', code: 0, host: 'EAGAIN' })
})

test('bookmarks follow a file through renames and moves', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const enc = new TextEncoder()
    const res: Record<string, unknown> = {}
    await k.mkdir('/tmp/a/deep', { recursive: true })
    await k.mkdir('/tmp/b', { recursive: true })
    await k.writeFile('/tmp/a/deep/note.txt', enc.encode('n'))
    const id = await k.bookmark('/tmp/a/deep/note.txt')
    res.same = (await k.bookmark('/tmp/a/deep/note.txt')) === id
    res.direct = await k.resolveBookmark(id)
    await k.rename('/tmp/a/deep/note.txt', '/tmp/a/deep/renamed.txt')
    res.renamed = await k.resolveBookmark(id)
    await k.rename('/tmp/a/deep/renamed.txt', '/tmp/b/moved.txt')
    res.moved = await k.resolveBookmark(id)
    await k.rename('/tmp/b', '/tmp/c')
    res.parentRenamed = await k.resolveBookmark(id)
    res.list = await k.listBookmarks()
    // a folder, and through a symlink
    const dir = await k.bookmark('/tmp/c')
    await k.symlink('/tmp/c', '/tmp/link')
    res.viaLink = (await k.bookmark('/tmp/link')) === dir
    await k.rename('/tmp/c', '/tmp/d')
    res.folder = await k.resolveBookmark(dir)
    // removing the bookmark clears the mark; deleting the file breaks it
    await k.removeBookmark(id)
    res.removed = [await k.resolveBookmark(id).catch((e) => e.code), await k.listxattr('/tmp/d/moved.txt')]
    const id2 = await k.bookmark('/tmp/d/moved.txt')
    await k.unlink('/tmp/d/moved.txt')
    res.deleted = await k.resolveBookmark(id2).catch((e) => e.code)
    res.unknown = await k.resolveBookmark('nope').catch((e) => e.code)
    res.missing = await k.bookmark('/tmp/nothing').catch((e) => e.code)
    return res
  })
  expect(out).toEqual({
    same: true, direct: '/tmp/a/deep/note.txt', renamed: '/tmp/a/deep/renamed.txt', moved: '/tmp/b/moved.txt', parentRenamed: '/tmp/c/moved.txt',
    list: [{ id: expect.any(String), path: '/tmp/c/moved.txt' }], viaLink: true, folder: '/tmp/d',
    removed: ['ENOENT', []], deleted: 'ENOENT', unknown: 'ENOENT', missing: 'ENOENT',
  })
})
