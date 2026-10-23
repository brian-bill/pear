/** Smaller pieces: icons and type conflicts, encrypted images, key layouts, idle and power, host transfer, tab lock. */
import { readFile } from 'node:fs/promises'
import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })

test('iconFor: apps show their icon, files a symbolic name by type, a custom icon wins, documents can bring their own', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const enc = new TextEncoder()
    await kernel.bundleInstall({
      files: {
        'manifest.json': JSON.stringify({ id: 'org.test.paint', name: 'Paint', version: '1.0.0', entry: 'main.js', icon: 'Resources/icon.png', documentTypes: [{ ext: ['png'], role: 'editor', icon: 'Resources/doc.png' }] }),
        'main.js': 'export default async () => {}', 'Resources/icon.png': 'icon', 'Resources/doc.png': 'doc',
      },
    }, { grant: true })
    await kernel.launchSetDefault('public.png', 'org.test.paint')
    await kernel.mkdir('/Users/pear/Documents/Folder', { recursive: true })
    for (const n of ['a.txt', 'b.md', 'c.json', 'd.js', 'e.png', 'f.bin']) await kernel.writeFile(`/Users/pear/Documents/${n}`, enc.encode('x'))
    await kernel.writeFile('/Users/pear/Documents/custom.txt', enc.encode('x'))
    await kernel.writeFile('/Users/pear/Documents/my-icon.png', enc.encode('x'))
    await kernel.setxattr('/Users/pear/Documents/custom.txt', 'user.icon', '/Users/pear/Documents/my-icon.png')
    await kernel.setxattr('/Users/pear/Documents/a.txt', 'user.icon', 'star')
    const icon = async (t: string) => { const i = await kernel.launchIconFor(t); return [i.source, i.name, i.path] }
    return {
      app: await icon('org.test.paint'), appPath: await icon('/Applications/Paint.app'), folder: await icon('/Users/pear/Documents/Folder'),
      txt: await icon('/Users/pear/Documents/b.md').then(async (md) => [md, await icon('/Users/pear/Documents/c.json'), await icon('/Users/pear/Documents/d.js'), await icon('/Users/pear/Documents/f.bin')]),
      doc: await icon('/Users/pear/Documents/e.png'), custom: await icon('/Users/pear/Documents/custom.txt'), named: await icon('/Users/pear/Documents/a.txt'),
      type: await icon('public.plain-text'),
    }
  })
  expect(out.app).toEqual(['app', 'app', '/Applications/Paint.app/Resources/icon.png'])
  expect(out.appPath).toEqual(out.app)
  expect(out.folder).toEqual(['type', 'folder', null])
  expect(out.txt).toEqual([['type', 'markdown', null], ['type', 'json', null], ['type', 'code', null], ['type', 'document', null]])
  expect(out.doc).toEqual(['type', 'image', '/Applications/Paint.app/Resources/doc.png'])
  expect(out.custom).toEqual(['custom', 'text', '/Users/pear/Documents/my-icon.png'])
  expect(out.named).toEqual(['custom', 'star', null])
  expect(out.type).toEqual(['type', 'text', null])
})

test('apps may define file types; system types always win; clashes are listed and the user can choose', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const app = (id: string, extra: object) => kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id, name: id, version: '1.0.0', entry: 'main.js', ...extra }), 'main.js': 'export default async () => {}' } }, { grant: true })
    await app('org.test.sketch', { typeDefinitions: [{ uti: 'org.test.sketch.drawing', conformsTo: ['public.image'], description: 'Sketch drawing', ext: ['skt'] }], documentTypes: [{ ext: ['skt'], uti: 'org.test.sketch.drawing', role: 'editor' }] })
    await app('org.test.rival', { typeDefinitions: [{ uti: 'org.test.rival.drawing', conformsTo: ['public.data'], ext: ['skt'] }, { uti: 'org.test.sketch.drawing', conformsTo: ['public.data'] }, { uti: 'org.test.rival.note', ext: ['txt'] }] })
    await kernel.writeFile('/Users/pear/Documents/x.skt', new TextEncoder().encode('x'))
    await kernel.writeFile('/Users/pear/Documents/y.txt', new TextEncoder().encode('x'))
    const before = await kernel.launchTypeOf('/Users/pear/Documents/x.skt')
    const txt = await kernel.launchTypeOf('/Users/pear/Documents/y.txt')
    const conflicts = await kernel.launchTypeConflicts()
    await kernel.launchSetTypeOwner('skt', 'org.test.rival.drawing')
    const chosen = await kernel.launchTypeOf('/Users/pear/Documents/x.skt')
    await kernel.launchSetTypeOwner('skt', null)
    const reset = await kernel.launchTypeOf('/Users/pear/Documents/x.skt')
    const bad = await kernel.launchSetTypeOwner('skt', 'no.such.type').then(() => 'ok', (e: any) => e.code)
    return {
      before: [before.uti, before.conformsTo.includes('public.image')], txt: txt.uti, chosen: chosen.uti, reset: reset.uti, bad,
      conflicts: conflicts.map((c) => [c.ext, c.uti, c.kept, c.claims.map((x) => x.appId).sort()]),
    }
  })
  expect(out.before).toEqual(['org.test.sketch.drawing', true])
  expect(out.txt).toBe('public.plain-text') // the system's mapping wins over an app
  expect(out.conflicts).toContainEqual(['skt', 'org.test.sketch.drawing', 'org.test.sketch', ['org.test.rival', 'org.test.sketch']])
  expect(out.conflicts).toContainEqual(['txt', 'public.plain-text', null, [null, 'org.test.rival']])
  expect(out.conflicts).toContainEqual([null, 'org.test.sketch.drawing', 'org.test.sketch', ['org.test.rival', 'org.test.sketch']])
  expect(out.chosen).toBe('org.test.rival.drawing')
  expect(out.reset).toBe('org.test.sketch.drawing')
  expect(out.bad).toBe('ENOENT')
})

test('disk images can be encrypted: the header needs the passphrase, a wrong one is refused, the right one restores', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    await kernel.writeFile('/Users/pear/Documents/secret.txt', new TextEncoder().encode('classified'))
    const plain = await kernel.imageCreate({ include: ['/Users/pear/Documents'] })
    const enc = await kernel.imageCreate({ include: ['/Users/pear/Documents'], passphrase: 'correct horse' })
    const attempt = (p?: string) => kernel.imageVerify(enc, p).then((i) => [i.ok, i.encrypted ?? false, i.error ?? ''])
    const leak = new TextDecoder().decode(new Uint8Array(await enc.arrayBuffer())).includes('classified')
    await kernel.unlink('/Users/pear/Documents/secret.txt')
    const noPass = await kernel.imageRestore(enc, { mode: 'merge' }).then(() => 'ok', (e: any) => e.code)
    const wrong = await kernel.imageRestore(enc, { mode: 'merge', passphrase: 'wrong' }).then(() => 'ok', (e: any) => e.code)
    const res = await kernel.imageRestore(enc, { mode: 'merge', passphrase: 'correct horse' })
    return {
      plainVerify: (await kernel.imageVerify(plain)).encrypted ?? false, none: await attempt(), wrongVerify: await attempt('nope'), good: await attempt('correct horse'),
      leak, noPass, wrong, restored: res.files, text: await window.sh.cat('/Users/pear/Documents/secret.txt'),
    }
  })
  expect(out.plainVerify).toBe(false)
  expect(out.none[0]).toBe(false)
  expect(out.none[1]).toBe(true)
  expect(out.none[2]).toMatch(/passphrase/)
  expect(out.wrongVerify[0]).toBe(false)
  expect(out.good).toEqual([true, true, ''])
  expect(out.leak).toBe(false)
  expect(out.noPass).toBe('EACCES')
  expect(out.wrong).toBe('EACCES')
  expect(out.restored).toBeGreaterThan(0)
  expect(out.text).toBe('classified')
})

test('keyboard layouts translate keys by their physical code; shortcuts follow the layout; us passes through', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    const inbox = await window.inbox()
    await ask('input', { op: 'subscribe', kinds: ['key'] }, [inbox.port])
    const press = async (code: string, key: string, extra: object = {}) => {
      await kernel.driverPush('input', { event: 'input', input: { kind: 'key', phase: 'down', code, key, ...extra } })
      return (await inbox.next(500))?.key
    }
    const us = [await press('KeyS', 's'), await press('Enter', 'Enter')]
    const setLayout = async (id: string) => {
      await ask('input', { op: 'setKeyboardLayout', id })
      await inbox.next(300) // the {type: 'layout'} notice
    }
    await setLayout('dvorak')
    const dvorak = [await press('KeyS', 's'), await press('KeyS', 'S', { shiftKey: true }), await press('KeyQ', 'q'), await press('Comma', ','), await press('Enter', 'Enter'), await press('ArrowUp', 'ArrowUp')]
    await setLayout('fr')
    const fr = [await press('KeyQ', 'q'), await press('KeyA', 'a'), await press('Digit1', '1'), await press('Digit1', '1', { shiftKey: true })]
    await setLayout('de')
    const de = [await press('KeyY', 'y'), await press('KeyZ', 'z')]
    await setLayout('us')
    return { us, dvorak, fr, de, back: await press('KeyS', 's') }
  })
  expect(out.us).toEqual(['s', 'Enter'])
  expect(out.dvorak).toEqual(['o', 'O', "'", 'w', 'Enter', 'ArrowUp'])
  expect(out.fr).toEqual(['a', 'q', '&', '1'])
  expect(out.de).toEqual(['z', 'y'])
  expect(out.back).toBe('s')
})

test('keyboard lock is requested through the page driver', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const detach = window.attachDrivers()
    await window.sh.sleep(200)
    const lock = await window.ask('input', { op: 'keyboardLock', keys: ['KeyW', 'KeyT'] })
    const state = await window.ask('input', { op: 'reserved' })
    const unlock = await window.ask('input', { op: 'keyboardUnlock' })
    const after = await window.ask('input', { op: 'reserved' })
    detach()
    return { lock, state, unlock, after }
  })
  // Chrome grants it to a top-level page; anywhere else the answer is an error code, not a hang
  if (out.lock && out.lock.error) expect(['ENOSYS', 'EPERM', 'EIO']).toContain(out.lock.error)
  else {
    expect(out.state.keyboardLock).toBe(true)
    expect(out.after.keyboardLock).toBe(false)
  }
})

test('the user-idle signal fires after inactivity and again on activity; power assertions hold it back', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel, sh } = window
    const inbox = await window.inbox()
    await ask('timers', { op: 'userIdle.watch', after: 1000 }, [inbox.port])
    await kernel.driverPush('timers', { event: 'activity' })
    const quiet = await inbox.next(500) // activity just happened: not idle
    const idle = await inbox.next(3500)
    await kernel.driverPush('timers', { event: 'activity' })
    const back = await inbox.next(1000)
    const hold = await ask('timers', { op: 'power.assert', type: 'idle', reason: 'playing a video' })
    await kernel.driverPush('timers', { event: 'activity' })
    const held = await inbox.next(2800) // would have gone idle by now
    const assertions = await ask('timers', { op: 'power.assertions' })
    const state = await ask('timers', { op: 'power.state' })
    await ask('timers', { op: 'power.release', id: hold })
    const bad = await ask('timers', { op: 'power.assert', type: 'idle' })
    return { quiet, idle, back, held, assertions: assertions.map((a: any) => [a.type, a.reason]), state, bad, idleMs: (await ask('timers', { op: 'userIdle.state' })).idleMs >= 0, sh: !!sh }
  })
  expect(out.quiet).toBeNull()
  expect(out.idle).toMatchObject({ type: 'userIdle', idle: true })
  expect(out.back).toEqual({ type: 'userIdle', idle: false })
  expect(out.held).toBeNull()
  expect(out.assertions).toEqual([['idle', 'playing a video']])
  expect(out.state).toMatchObject({ preventsIdle: true, preventsSleep: false })
  expect(out.bad).toEqual({ error: 'EINVAL' })
})

test('importing: files and folders are streamed in with a quarantine mark; cancel leaves no half file; existing files can be kept', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, hostTransfer: h } = window
    const file = (name: string, text: string) => new File([text], name)
    const session = {
      items: [
        { path: 'Pics/a.txt', file: file('a.txt', 'alpha') },
        { path: 'Pics/deep/b.txt', file: file('b.txt', 'bravo') },
        { path: '../../etc/escape.txt', file: file('escape.txt', 'no') },
      ],
      emptyDirs: ['Pics/empty'], bytes: 15,
    }
    const written = await h.importCommit(kernel, session, '/Users/pear/Documents/Imported')
    const steps: number[] = []
    await h.importCommit(kernel, { items: [{ path: 'again.txt', file: file('again.txt', 'second') }], emptyDirs: [], bytes: 6 }, '/Users/pear/Documents/Imported', { progress: (d) => void steps.push(d) })
    await kernel.writeFile('/Users/pear/Documents/Imported/keep.txt', new TextEncoder().encode('mine'))
    await h.importCommit(kernel, { items: [{ path: 'keep.txt', file: file('keep.txt', 'theirs') }], emptyDirs: [], bytes: 6 }, '/Users/pear/Documents/Imported', { keepExisting: true })
    const big = new File([new Uint8Array(9 * 1024 * 1024)], 'big.bin')
    const cancelled = await h.importCommit(kernel, { items: [{ path: 'big.bin', file: big }], emptyDirs: [], bytes: big.size }, '/Users/pear/Documents/Imported', { progress: () => false }).then(() => 'ok', (e: any) => e.code)
    return {
      written, a: await window.sh.cat('/Users/pear/Documents/Imported/Pics/a.txt'), quarantine: await kernel.getxattr('/Users/pear/Documents/Imported/Pics/a.txt', 'com.apple.quarantine'),
      empty: (await kernel.stat('/Users/pear/Documents/Imported/Pics/empty')).kind, escaped: await kernel.exists('/etc/escape.txt'), safe: await kernel.exists('/Users/pear/Documents/Imported/etc/escape.txt'),
      steps, keep: await window.sh.cat('/Users/pear/Documents/Imported/keep.txt'), cancelled, half: await kernel.exists('/Users/pear/Documents/Imported/big.bin'),
    }
  })
  expect(out.written).toHaveLength(3)
  expect(out.a).toBe('alpha')
  expect(out.quarantine).toMatch(/^0081;[0-9a-f]+;host;a\.txt$/)
  expect(out.empty).toBe('dir')
  expect(out.escaped).toBe(false)
  expect(out.safe).toBe(true) // ".." parts are dropped, the file lands inside the destination
  expect(out.steps.at(-1)).toBe(6)
  expect(out.keep).toBe('mine')
  expect(out.cancelled).toBe('ECANCELED')
  expect(out.half).toBe(false)
})

test('exporting: a file downloads as is; a folder downloads as a zip with every file', async ({ page }) => {
  await page.evaluate(async () => {
    const { kernel } = window
    const enc = new TextEncoder()
    await kernel.mkdir('/Users/pear/Documents/Out/sub', { recursive: true })
    await kernel.mkdir('/Users/pear/Documents/Out/hollow', { recursive: true })
    await kernel.writeFile('/Users/pear/Documents/Out/one.txt', enc.encode('first'))
    await kernel.writeFile('/Users/pear/Documents/Out/sub/two.txt', enc.encode('second'))
  })
  const [file] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.hostTransfer.exportFile(window.kernel, '/Users/pear/Documents/Out/one.txt')),
  ])
  expect(file.suggestedFilename()).toBe('one.txt')
  expect(await readFile((await file.path())!, 'utf8')).toBe('first')

  const [zip] = await Promise.all([
    page.waitForEvent('download'),
    page.evaluate(() => window.hostTransfer.exportDirectory(window.kernel, '/Users/pear/Documents/Out')),
  ])
  expect(zip.suggestedFilename()).toBe('Out.zip')
  const bytes = await readFile((await zip.path())!)
  const text = bytes.toString('latin1')
  for (const name of ['one.txt', 'sub/two.txt', 'hollow/']) expect(text).toContain(name)
  expect(text).toContain('first')
  expect(text).toContain('second')
  expect(bytes.readUInt32LE(0)).toBe(0x04034b50) // local file header
  expect(bytes.readUInt32LE(bytes.length - 22)).toBe(0x06054b50) // end of central directory
  expect(bytes.readUInt16LE(bytes.length - 22 + 10)).toBe(3) // three entries
})

test('a second tab does not boot; it can take over, and the first is told', async ({ page, context }) => {
  const second = await context.newPage()
  await second.goto('/')
  await second.waitForFunction(() => window.harnessReady)
  await page.evaluate(async () => {
    ;(window as any).told = false
    ;(window as any).g1 = await window.guardTabs('lock-test', () => { ;(window as any).told = true })
  })
  const owner2 = await second.evaluate(async () => {
    ;(window as any).g2 = await window.guardTabs('lock-test')
    return (window as any).g2.owner as boolean
  })
  expect(await page.evaluate(() => (window as any).g1.owner)).toBe(true)
  expect(owner2).toBe(false)
  await second.evaluate(() => (window as any).g2.takeOver())
  expect(await second.evaluate(() => (window as any).g2.owner)).toBe(true)
  expect(await page.evaluate(() => (window as any).told)).toBe(true)
  // another namespace is independent
  expect(await second.evaluate(async () => (await window.guardTabs('other')).owner)).toBe(true)
  await second.close()
})

test('the service worker caches the OS for offline use', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const manifest = (await (await fetch('/os-manifest.json')).json()) as string[]
    const reg = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    const worker = reg.active ?? reg.installing ?? reg.waiting
    for (let i = 0; i < 50 && worker?.state !== 'activated'; i++) await new Promise((r) => setTimeout(r, 100))
    const names = (await caches.keys()).filter((n) => n.startsWith('tiny-os-'))
    const cached = names.length ? (await (await caches.open(names[0]!)).keys()).length : 0
    await reg.unregister()
    return { manifest, names, cached }
  })
  expect(out.manifest).toEqual(expect.arrayContaining(['./', 'worker.js', 'main.js', 'process.js', 'host.html', 'services.json', 'userland.json', 'tiny_vanilla_bg.wasm']))
  expect(out.manifest).not.toContain('sw.js')
  expect(out.names).toHaveLength(1)
  expect(out.cached).toBe(out.manifest.length)
})
