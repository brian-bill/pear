/**
 * Crash safety on real OPFS: the kernel Worker is killed without a shutdown and a new one boots on the same
 * storage (`sh.crash`). The engine-level cases (torn writes at every point) are in vfs/tests/hardening.rs.
 */
import { expect, test } from './fixtures'

test('everything that was flushed survives a crash, replayed from the journal', async ({ page, ns }) => {
  const res = await page.evaluate(async (ns) => {
    const enc = new TextEncoder()
    const dec = new TextDecoder()
    let { kernel } = window
    await kernel.mkdir('/Users/me/Docs', { recursive: true })
    for (let i = 0; i < 20; i++) await kernel.writeFile(`/Users/me/Docs/f${i}.txt`, enc.encode(`file ${i}`))
    await kernel.rename('/Users/me/Docs/f0.txt', '/Users/me/Docs/renamed.txt')
    await kernel.unlink('/Users/me/Docs/f1.txt')
    await kernel.setxattr('/Users/me/Docs/f2.txt', 'tag', 'red')
    await kernel.flush()

    const recovery = await window.sh.crash(ns)
    kernel = window.kernel
    const names = (await kernel.readdir('/Users/me/Docs')).map((e) => e.name).sort()
    return {
      recovery,
      names,
      renamed: dec.decode(await kernel.readFile('/Users/me/Docs/renamed.txt')),
      last: dec.decode(await kernel.readFile('/Users/me/Docs/f19.txt')),
      tag: await kernel.getxattr('/Users/me/Docs/f2.txt', 'tag'),
    }
  }, ns)
  expect(res.recovery.replayedRecords).toBeGreaterThan(0)
  expect(res.recovery.discardedJournalBytes).toBe(0)
  expect(res.names).toHaveLength(19)
  expect(res.names).toContain('renamed.txt')
  expect(res.names).not.toContain('f1.txt')
  expect(res.renamed).toBe('file 0')
  expect(res.last).toBe('file 19')
  expect(res.tag).toBe('red')
})

test('a crash with changes still unflushed leaves whole files or none, and no stray data files', async ({ page, ns }) => {
  const res = await page.evaluate(async (ns) => {
    let { kernel } = window
    const body = (i: number) => new Uint8Array(10_000).fill(65 + (i % 26))
    for (let i = 0; i < 30; i++) await kernel.writeFile(`/tmp/n${i}`, body(i))
    const recovery = await window.sh.crash(ns) // right away: most of this was never journalled
    kernel = window.kernel

    const present: number[] = []
    const damaged: number[] = []
    for (const e of await kernel.readdir('/tmp')) {
      const i = Number(e.name.slice(1))
      const data = await kernel.readFile(`/tmp/${e.name}`)
      const whole = data.length === 10_000 && data.every((b) => b === 65 + (i % 26))
      ;(whole ? present : damaged).push(i)
    }
    // Every data file on disk belongs to a file in the tree.
    const inos = new Set<string>()
    for (const e of await kernel.readdir('/tmp')) inos.add(String((await kernel.stat(`/tmp/${e.name}`)).ino))
    const blobs = await window.sh.blobNames(ns)
    return { recovery, present: present.length, damaged, stray: blobs.filter((b) => !inos.has(b)) }
  }, ns)
  expect(res.damaged).toEqual([])
  expect(res.stray).toEqual([])
  expect(res.present).toBeLessThanOrEqual(30)
})

test('blobs with no file are removed at boot, and their OPFS files deleted', async ({ page, ns }) => {
  const res = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    await kernel.writeFile('/tmp/real', new TextEncoder().encode('real'))
    await kernel.flush()
    // What a crash between writing a file's data and journalling the file leaves behind.
    const root = await navigator.storage.getDirectory()
    const data = await (await root.getDirectoryHandle(ns)).getDirectoryHandle('data')
    for (const name of ['99991', '99992']) {
      const w = await (await data.getFileHandle(name, { create: true })).createWritable()
      await w.write('leftover')
      await w.close()
    }
    const before = await sh.blobNames(ns)
    const recovery = await sh.crash(ns)
    return {
      before,
      recovery,
      after: await sh.blobNames(ns),
      real: new TextDecoder().decode(await window.kernel.readFile('/tmp/real')),
    }
  }, ns)
  expect(res.before).toContain('99991')
  expect(res.recovery.orphanBlobsRemoved).toBe(2)
  expect(res.after).not.toContain('99991')
  expect(res.after).not.toContain('99992')
  expect(res.real).toBe('real')
})

test('a file removed but not yet flushed keeps its data if the kernel dies', async ({ page, ns }) => {
  const res = await page.evaluate(async (ns) => {
    const enc = new TextEncoder()
    const { kernel, sh } = window
    await kernel.writeFile('/tmp/precious', enc.encode('do not lose me'))
    await kernel.flush()
    await kernel.unlink('/tmp/precious')
    await sh.crash(ns)
    const k = window.kernel
    // Either the removal made it to the journal (gone) or it did not (still there, with all its data).
    if (!(await k.exists('/tmp/precious'))) return 'removed'
    return new TextDecoder().decode(await k.readFile('/tmp/precious'))
  }, ns)
  expect(['removed', 'do not lose me']).toContain(res)
})

test('flushing appends small journal records; the full index is not rewritten', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const enc = new TextEncoder()
    const { kernel } = window
    for (let d = 0; d < 150; d++) {
      await kernel.mkdir(`/Users/u${d}/Documents`, { recursive: true })
      await kernel.writeFile(`/Users/u${d}/Documents/notes.txt`, enc.encode('notes'))
    }
    await kernel.fsCheckpoint()
    const before = (await kernel.fsInfo()).journal
    for (let i = 0; i < 20; i++) {
      await kernel.writeFile(`/Users/u7/Documents/f${i}`, enc.encode('x'))
      await kernel.flush()
    }
    const after = (await kernel.fsInfo()).journal
    return { before, after }
  })
  expect(res.after.records - res.before.records).toBeGreaterThanOrEqual(20)
  expect(res.after.checkpoints).toBe(res.before.checkpoints)
  expect(res.before.indexBytes).toBeGreaterThan(30_000)
  // Everything those 20 flushes (and any background ones) wrote is a small fraction of one index rewrite.
  expect(res.after.journalBytes).toBeLessThan(res.before.indexBytes)
})

test('a clean shutdown folds the journal into the index, so the next boot replays nothing', async ({ page, ns }) => {
  const res = await page.evaluate(async (ns) => {
    const { kernel } = window
    await kernel.writeFile('/tmp/a', new TextEncoder().encode('a'))
    await kernel.flush()
    await kernel.writeFile('/tmp/b', new TextEncoder().encode('b'))
    await kernel.shutdown()
    await kernel.boot({ namespace: ns })
    return { info: await kernel.fsInfo(), a: await kernel.exists('/tmp/a'), b: await kernel.exists('/tmp/b') }
  }, ns)
  expect(res.info.recovery).toEqual({
    replayedRecords: 0,
    discardedJournalBytes: 0,
    orphanBlobsRemoved: 0,
    unlinkedFilesFreed: 0,
    upgradedIndex: false,
  })
  expect(res.info.journal.journalBytes).toBe(0)
  expect(res.a && res.b).toBe(true)
})

test('statfs reports the browser quota for the origin', async ({ page }) => {
  const res = await page.evaluate(async () => {
    const { kernel } = window
    await kernel.writeFile('/tmp/f', new Uint8Array(5000))
    return kernel.statfs()
  })
  expect(res.used).toBeGreaterThanOrEqual(5000)
  expect(res.total).toBeGreaterThan(10_000_000)
  expect(res.free).toBeLessThanOrEqual(res.total!)
  expect(res.free).toBeGreaterThan(0)
})
