/**
 * App bundles and launch services: install, validation, integrity, the type system, opening files and URLs,
 * single-instance apps, and process types.
 */
import { expect, test } from './fixtures'

test('install checks the manifest and the files, and leaves nothing behind when it refuses', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const ok = 'export default () => 0'
    const fail = (files: Record<string, string>) => kernel.bundleInstall({ files }).then(() => 'installed', (e) => `${e.code}: ${e.message}`)
    const m = (o: object = {}) => JSON.stringify({ id: 'com.example.t', name: 'T', version: '1.0.0', ...o })
    const r = {
      noManifest: await fail({ 'main.js': ok }),
      notJson: await fail({ 'manifest.json': '{', 'main.js': ok }),
      badId: await fail({ 'manifest.json': m({ id: 'nope' }), 'main.js': ok }),
      badVersion: await fail({ 'manifest.json': m({ version: 'x' }), 'main.js': ok }),
      noEntry: await fail({ 'manifest.json': m(), 'other.js': ok }),
      escapingEntry: await fail({ 'manifest.json': m({ entry: '../x.js' }), 'main.js': ok }),
      badPermission: await fail({ 'manifest.json': m({ permissions: ['root'] }), 'main.js': ok }),
      newerOS: await fail({ 'manifest.json': m({ minOS: '9.0' }), 'main.js': ok }),
      reservedScheme: await fail({ 'manifest.json': m({ urlSchemes: ['javascript'] }), 'main.js': ok }),
      missingIcon: await fail({ 'manifest.json': m({ icon: 'Resources/icon.png' }), 'main.js': ok }),
      badLocation: await kernel.bundleInstall({ files: { 'manifest.json': m(), 'main.js': ok } }, { location: '/tmp' }).then(() => 'installed', (e) => e.code),
      installed: (await kernel.bundleList()).length,
      leftovers: (await kernel.readdir('/tmp')).map((e) => e.name),
    }
    return r
  })
  for (const key of ['noManifest', 'notJson', 'badId', 'badVersion', 'noEntry', 'escapingEntry', 'badPermission', 'newerOS', 'reservedScheme', 'missingIcon']) {
    expect(out[key as keyof typeof out], key).toMatch(/^(EINVAL|ENOENT)/)
  }
  expect(out.badId).toContain('reverse-DNS')
  expect(out.newerOS).toContain('requires OS')
  expect(out.badLocation).toBe('EINVAL')
  expect(out.installed).toBe(0)
  expect(out.leftovers).toEqual([])
})

test('an installed bundle is listed, has its own data folders, and uninstall keeps data unless asked', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const ok = 'export default () => 0'
    const events: string[] = []
    kernel.onEvent((e) => e.type === 'bundle' && events.push(`${e.event}:${e.id}`))
    const info = await sh.app('com.example.alpha', ok, { permissions: ['clipboard'], documentTypes: [{ ext: ['TXT'], role: 'editor' }] })
    const again = await sh.app('com.example.alpha', ok).then(() => 'installed', (e) => e.code)
    const sameName = await sh.app('com.other.alpha', ok).then(() => 'installed', (e) => e.code)
    const container = await kernel.stat(info.container)
    await kernel.writeFile(`${info.container}/data.txt`, new TextEncoder().encode('mine'))
    await kernel.bundleUninstall('com.example.alpha')
    const keptData = await kernel.exists(`${info.container}/data.txt`)
    const listedAfter = (await kernel.bundleList()).length
    await sh.app('com.example.alpha', ok)
    await kernel.bundleUninstall('com.example.alpha', { deleteData: true })
    const gone = await kernel.exists(info.container)
    const missing = await kernel.bundleInfo('com.example.alpha').then(() => 'found', (e) => e.code)
    return { info, again, sameName, container, keptData, listedAfter, gone, missing, events }
  })
  expect(out.info).toMatchObject({
    id: 'com.example.alpha', name: 'alpha', kind: 'app', path: '/Applications/alpha.app', entryPath: '/Applications/alpha.app/main.js',
    container: '/Users/pear/Library/Containers/com.example.alpha', singleInstance: true, system: false,
    documentTypes: [{ ext: ['txt'], role: 'editor' }],
  })
  expect(out.again).toBe('EEXIST')
  expect(out.sameName).toBe('EEXIST')
  expect(out.container).toMatchObject({ kind: 'dir', uid: 501, gid: 20, mode: 0o700 })
  expect(out.keptData).toBe(true)
  expect(out.listedAfter).toBe(0)
  expect(out.gone).toBe(false)
  expect(out.missing).toBe('ENOENT')
  expect(out.events).toEqual(['installed:com.example.alpha', 'removed:com.example.alpha', 'installed:com.example.alpha', 'removed:com.example.alpha'])
})

test('content hashes are checked on install and by verify; a directory in the VFS can be installed', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const ok = 'export default () => 0'
    const sha = async (t: string) =>
      [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t)))].map((b) => b.toString(16).padStart(2, '0')).join('')
    const manifest = (hashes: object) => JSON.stringify({ id: 'com.example.hashed', name: 'Hashed', version: '1.0.0', hashes })
    const bad = await kernel.bundleInstall({ files: { 'manifest.json': manifest({ 'main.js': 'f'.repeat(64) }), 'main.js': ok } }).then(() => 'installed', (e) => e.message)
    const missing = await kernel.bundleInstall({ files: { 'manifest.json': manifest({ 'nope.js': 'f'.repeat(64) }), 'main.js': ok } }).then(() => 'installed', (e) => e.message)

    // as a directory somewhere else in the VFS (a download, say)
    await kernel.mkdir('/tmp/Src.app/Resources', { recursive: true })
    await kernel.writeFile('/tmp/Src.app/manifest.json', new TextEncoder().encode(manifest({ 'main.js': await sha(ok) })))
    await kernel.writeFile('/tmp/Src.app/main.js', new TextEncoder().encode(ok))
    await kernel.writeFile('/tmp/Src.app/Resources/note.txt', new TextEncoder().encode('hello'))
    const info = await kernel.bundleInstall({ path: '/tmp/Src.app' })
    const copied = new TextDecoder().decode(await kernel.readFile('/Applications/Hashed.app/Resources/note.txt'))
    const sourceKept = await kernel.exists('/tmp/Src.app')
    const fine = await kernel.bundleVerify('/Applications/Hashed.app')
    await kernel.writeFile('/Applications/Hashed.app/main.js', new TextEncoder().encode('export default () => 1'))
    const tampered = await kernel.bundleVerify('/Applications/Hashed.app')
    return { bad, missing, verified: info.verified, copied, sourceKept, fine, tampered }
  })
  expect(out.bad).toContain('integrity check failed')
  expect(out.bad).toContain('main.js')
  expect(out.missing).toContain('nope.js: missing')
  expect(out.verified).toBe(true)
  expect(out.copied).toBe('hello')
  expect(out.sourceKept).toBe(true)
  expect(out.fine).toEqual({ ok: true, checked: 1, problems: [] })
  expect(out.tampered).toMatchObject({ ok: false, problems: ['main.js: hash does not match'] })
})

test('launch by id starts the entry as the user, in its container, with its identity', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.app(
      'com.example.hello',
      `export default async (t) => {
         await t.writeFile('out.json', new TextEncoder().encode(JSON.stringify({
           args: t.args, uid: await t.getuid(), gid: await t.getgid(), app: await t.getappid(), name: t.name,
           cwd: await t.getcwd(), home: await t.getenv('HOME'), id: await t.getenv('TINY_APP_ID'), kind: await t.getenv('TINY_APP_KIND'),
         })))
       }`,
    )
    const events: string[] = []
    kernel.onEvent((e) => e.type === 'launch' && events.push(`${e.event}:${e.appId}`))
    const pid = await kernel.launchOpen('com.example.hello', { args: ['one', 'two'] })
    const status = await kernel.wait(pid)
    const bad = await kernel.launchOpen('com.example.nothing').then(() => 'ok', (e) => e.code)
    const notId = await kernel.launchOpen('relative/path').then(() => 'ok', (e) => e.code)
    return { status, bad, notId, events, out: JSON.parse(await sh.cat('/Users/pear/Library/Containers/com.example.hello/out.json')) }
  })
  expect(out.status).toMatchObject({ code: 0, crashed: false })
  expect(out.out).toEqual({
    args: ['one', 'two'], uid: 501, gid: 20, app: 'com.example.hello', name: 'hello',
    cwd: '/Users/pear/Library/Containers/com.example.hello', home: '/Users/pear', id: 'com.example.hello', kind: 'app',
  })
  expect(out.bad).toBe('ENOENT')
  expect(out.notId).toBe('EINVAL')
  expect(out.events).toContain('launched:com.example.hello')
  expect(out.events).toContain('terminated:com.example.hello')
})

test('file types come from the extension, then the first bytes; they conform up a hierarchy', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    await kernel.mkdir('/tmp/t', { recursive: true })
    const put = (name: string, bytes: number[] | string) =>
      kernel.writeFile(`/tmp/t/${name}`, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : new Uint8Array(bytes))
    await put('a.TXT', 'x')
    await put('b.md', '# x')
    await put('c', [0x89, 0x50, 0x4e, 0x47, 13, 10])
    await put('d.unknownext', 'x')
    await put('e.png', 'not really a png')
    await kernel.mkdir('/tmp/t/dir')
    await kernel.mkdir('/tmp/t/Some.app')
    await kernel.symlink('/tmp/t/a.TXT', '/tmp/t/link')
    const t = async (n: string) => kernel.launchTypeOf(`/tmp/t/${n}`)
    return { txt: await t('a.TXT'), md: await t('b.md'), magic: await t('c'), unknown: await t('d.unknownext'), png: await t('e.png'), dir: await t('dir'), app: await t('Some.app'), link: await t('link') }
  })
  expect(out.txt).toMatchObject({ uti: 'public.plain-text', mime: 'text/plain', ext: 'txt' })
  expect(out.md.uti).toBe('net.daringfireball.markdown')
  expect(out.md.conformsTo).toEqual(['net.daringfireball.markdown', 'public.plain-text', 'public.text', 'public.data', 'public.item'])
  expect(out.magic).toMatchObject({ uti: 'public.png', mime: 'image/png' })
  expect(out.magic.conformsTo).toContain('public.image')
  expect(out.unknown.uti).toBe('public.data')
  expect(out.png.uti).toBe('public.png') // by extension, whatever the content
  expect(out.dir.uti).toBe('public.folder')
  expect(out.app.uti).toBe('com.apple.application-bundle')
  expect(out.link.uti).toBe('public.plain-text') // a link is its target
})

test('every common media extension classifies as audio or video', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    await kernel.mkdir('/tmp/t', { recursive: true })
    const exts = {
      audio: ['mp3', 'wav', 'aif', 'aiff', 'aifc', 'm4a', 'm4b', 'm4r', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'wma', 'mid', 'midi', 'caf', 'au', 'amr', 'mka'],
      video: ['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', 'avi', 'wmv', 'asf', 'mpg', 'mpeg', 'm1v', 'm2v', 'vob', 'ts', 'm2ts', 'mts', 'ogv', '3gp', '3g2', 'flv', 'f4v', 'dv'],
      image: ['bmp', 'tif', 'tiff'],
    }
    for (const list of Object.values(exts)) for (const e of list) await kernel.writeFile(`/tmp/t/p.${e}`, new Uint8Array([1]))
    const con = (name: string) => kernel.launchTypeOf(`/tmp/t/p.${name}`).then((t) => t.conformsTo)
    const r: Record<string, string[]> = {}
    for (const [kind, list] of Object.entries(exts)) for (const e of list) r[`${kind}:${e}`] = await con(e)
    return r
  })
  for (const [key, conforms] of Object.entries(out)) expect(conforms, key).toContain(key.startsWith('audio') ? 'public.audio' : key.startsWith('video') ? 'public.movie' : 'public.image')
})

test('open a file: best app by type, the user\'s default wins, and the app can use that file', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const reader = (label: string) => `export default async (t) => {
      const text = new TextDecoder().decode(await t.readFile(t.args[0]))
      await t.writeFile('seen.txt', new TextEncoder().encode('${label}:' + t.args[0] + ':' + text))
    }`
    await sh.app('com.example.edit', reader('edit'), { documentTypes: [{ ext: ['txt', 'md'], role: 'editor' }] })
    await sh.app('com.example.view', reader('view'), { documentTypes: [{ ext: [], uti: 'public.text', role: 'viewer' }] })
    await sh.app('com.example.mail', `export default async (t) => { await t.writeFile('seen.txt', new TextEncoder().encode('mail:' + t.args[0])) }`, { urlSchemes: ['mail'] })
    await kernel.mkdir('/Users/pear/Documents', { recursive: true })
    await kernel.writeFile('/Users/pear/Documents/note.txt', new TextEncoder().encode('hello'))
    await kernel.writeFile('/Users/pear/Documents/x.bin', new Uint8Array([1, 2, 3]))

    const ids = async (t: string) => (await kernel.launchAppsFor(t)).map((a) => a.id)
    const candidates = { txt: await ids('/Users/pear/Documents/note.txt'), type: await ids('public.plain-text'), mail: await ids('mail:me@example.com'), bin: await ids('/Users/pear/Documents/x.bin') }
    const noDefault = await kernel.launchDefaultFor('public.plain-text')

    const seen = async (id: string) => sh.cat(`/Users/pear/Library/Containers/${id}/seen.txt`)
    // best match: the app that names the extension
    await kernel.wait(await kernel.launchOpen('/Users/pear/Documents/note.txt'))
    const first = await seen('com.example.edit')
    // the user's choice wins; "open with" ignores it
    await kernel.launchSetDefault('public.plain-text', 'com.example.view')
    const chosen = (await kernel.launchDefaultFor('net.daringfireball.markdown'))?.id
    const orderAfter = await ids('/Users/pear/Documents/note.txt')
    await kernel.wait(await kernel.launchOpen('/Users/pear/Documents/note.txt'))
    const second = await seen('com.example.view')
    await kernel.wait(await kernel.launchOpenWith('/Users/pear/Documents/note.txt', 'com.example.edit'))
    // a URL goes to the app for its scheme
    await kernel.wait(await kernel.launchOpen('mail:me@example.com'))
    const mailSeen = await seen('com.example.mail')
    const noApp = await kernel.launchOpen('gopher://x').then(() => 'ok', (e) => e.code)
    const noTypeApp = await kernel.launchOpen('/Users/pear/Documents/x.bin').then(() => 'ok', (e) => `${e.code}: ${e.message}`)
    const recents = (await kernel.launchRecents()).map((r) => `${r.appId} ${r.target}`)
    return { candidates, noDefault, mailSeen, first, chosen, orderAfter, second, noApp, noTypeApp, recents }
  })
  expect(out.candidates.txt).toEqual(['com.example.edit', 'com.example.view'])
  expect(out.candidates.type).toEqual(['com.example.edit', 'com.example.view'])
  expect(out.candidates.mail).toEqual(['com.example.mail'])
  expect(out.candidates.bin).toEqual([])
  expect(out.noDefault).toBeNull()
  expect(out.first).toBe('edit:/Users/pear/Documents/note.txt:hello')
  expect(out.chosen).toBe('com.example.view')
  expect(out.orderAfter[0]).toBe('com.example.view')
  expect(out.second).toBe('view:/Users/pear/Documents/note.txt:hello')
  expect(out.mailSeen).toBe('mail:mail:me@example.com')
  expect(out.noApp).toBe('ENOENT')
  expect(out.noTypeApp).toContain('ENOENT')
  expect(out.noTypeApp).toContain('public.data')
  expect(out.recents[0]).toContain('com.example.mail mail:me@example.com')
  expect(out.recents).toContain('com.example.edit /Users/pear/Documents/note.txt')
})

test('a running single-instance app receives the open request instead of a second process', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.app(
      'com.example.single',
      `export default async (t) => {
         const port = await t.portCreate()
         await t.register('app.com.example.single', port)
         const log = async (line) => { const fd = await t.open('/tmp/single.log', 0x1 | 0x40 | 0x400); await t.write(fd, new TextEncoder().encode(line + '\\n')); await t.close(fd) }
         await log('start ' + t.args.join(','))
         for (;;) { const m = await t.receive(port); await log(m.data.type + ' ' + (m.data.path ?? '')) }
       }`,
      { documentTypes: [{ ext: ['txt'], role: 'viewer' }] },
    )
    await kernel.mkdir('/Users/pear/Documents', { recursive: true })
    await kernel.writeFile('/Users/pear/Documents/a.txt', new TextEncoder().encode('a'))
    await kernel.writeFile('/Users/pear/Documents/b.txt', new TextEncoder().encode('b'))
    const activated: number[] = []
    kernel.onEvent((e) => e.type === 'launch' && e.event === 'activated' && activated.push(e.pid))
    const [p1, p2] = await Promise.all([kernel.launchOpen('/Users/pear/Documents/a.txt'), kernel.launchOpen('/Users/pear/Documents/a.txt')])
    await sh.waitFor('/tmp/single.log')
    const p3 = await kernel.launchOpen('/Users/pear/Documents/b.txt')
    const p4 = await kernel.launchActivate('com.example.single')
    for (let i = 0; i < 100 && (await sh.cat('/tmp/single.log')).split('\n').length < 5; i++) await sh.sleep(20)
    const running = await kernel.launchRunning()
    const procs = (await kernel.listProcesses()).filter((p) => p.bundleId === 'com.example.single' && p.state === 'running')
    await kernel.kill(p1)
    await kernel.wait(p1)
    return { same: [p1 === p2, p3 === p1, p4 === p1], log: await sh.cat('/tmp/single.log'), running, count: procs.length, activated: activated.length, after: await kernel.launchRunning() }
  })
  expect(out.same).toEqual([true, true, true])
  expect(out.count).toBe(1)
  expect(out.log.trim().split('\n')).toEqual(['start /Users/pear/Documents/a.txt', 'openFile /Users/pear/Documents/b.txt', 'activate'])
  expect(out.running).toMatchObject([{ id: 'com.example.single', name: 'single' }])
  expect(out.activated).toBeGreaterThanOrEqual(3)
  expect(out.after).toEqual([])
})

test('an app that crashes while starting makes launch fail with what it said', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.app('com.example.boom', `export default async () => { throw new Error('boom at start') }`)
    await sh.app('com.example.syntax', `export default (`)
    const boom = await kernel.launchOpen('com.example.boom').then(() => 'started', (e) => `${e.code}: ${e.message}`)
    const syntax = await kernel.launchOpen('com.example.syntax').then(() => 'started', (e) => `${e.code}: ${e.message}`)
    return { boom, syntax, running: await kernel.launchRunning() }
  })
  expect(out.boom).toMatch(/^EIO: boom quit while starting \(code 1\).*boom at start/)
  expect(out.syntax).toMatch(/^EIO: syntax quit while starting/)
  expect(out.running).toEqual([])
})

test('process types: apps are listed and shown as running, tools and services are not', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const idle = `export default async () => { await new Promise(() => {}) }`
    await sh.app('com.example.gui', idle)
    await sh.app('com.example.cli', idle, { kind: 'tool' })
    await sh.app('com.example.daemon', idle, { kind: 'service' })
    const apps = (await kernel.launchApps()).map((a) => a.id)
    const all = (await kernel.bundleList()).map((b) => `${b.id}:${b.kind}:${b.singleInstance}`).sort()
    const pids = [await kernel.launchOpen('com.example.gui'), await kernel.launchOpen('com.example.cli'), await kernel.launchOpen('com.example.cli'), await kernel.launchOpen('com.example.daemon')]
    const running = (await kernel.launchRunning()).map((r) => r.id)
    const kinds = (await kernel.listProcesses()).filter((p) => p.bundleId).map((p) => `${p.bundleId}:${p.kind}`).sort()
    const toolsDiffer = pids[1] !== pids[2]
    const daemonAgain = (await kernel.launchOpen('com.example.daemon')) === pids[3]
    return { apps, all, running, kinds, toolsDiffer, daemonAgain }
  })
  expect(out.apps).toEqual(['com.example.gui'])
  expect(out.all).toEqual(['com.example.cli:tool:false', 'com.example.daemon:service:true', 'com.example.gui:app:true'])
  expect(out.running).toEqual(['com.example.gui'])
  expect(out.kinds).toEqual(['com.example.cli:tool', 'com.example.cli:tool', 'com.example.daemon:service', 'com.example.gui:app'])
  expect(out.toolsDiffer).toBe(true)
  expect(out.daemonAgain).toBe(true)
})

test('update replaces a running app after asking it to quit, keeps its data; uninstall refuses while it runs', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const v = (n: string) => `export default async (t) => { await t.writeFile('v.txt', new TextEncoder().encode('${n}')); await new Promise(() => {}) }`
    const files = (version: string, n: string, id = 'com.example.up') => ({
      'manifest.json': JSON.stringify({ id, name: 'Up', version }),
      'main.js': v(n),
    })
    await kernel.bundleInstall({ files: files('1.0.0', 'one') })
    const pid = await kernel.launchOpen('com.example.up')
    await sh.waitFor('/Users/pear/Library/Containers/com.example.up/v.txt')
    const busy = await kernel.bundleUninstall('com.example.up').then(() => 'removed', (e) => e.code)
    const wrongId = await kernel.bundleUpdate('com.example.up', { files: files('2.0.0', 'x', 'com.example.other') }).then(() => 'ok', (e) => e.code)
    const exits: Array<string | null> = []
    kernel.onEvent((e) => e.type === 'process' && e.event === 'exited' && e.pid === pid && exits.push(e.status.signal))
    const info = await kernel.bundleUpdate('com.example.up', { files: files('2.0.0', 'two') })
    const pid2 = await kernel.launchOpen('com.example.up')
    for (let i = 0; i < 100 && (await sh.cat('/Users/pear/Library/Containers/com.example.up/v.txt')) !== 'two'; i++) await sh.sleep(20)
    const result = { busy, wrongId, version: info.version, oldSignal: exits[0], now: await sh.cat('/Users/pear/Library/Containers/com.example.up/v.txt'), list: (await kernel.bundleList()).map((b) => b.version), pid2 }
    await kernel.kill(pid2)
    return result
  })
  expect(out.busy).toBe('EBUSY')
  expect(out.wrongId).toBe('EINVAL')
  expect(out.version).toBe('2.0.0')
  expect(out.oldSignal).toBe('SIGTERM')
  expect(out.now).toBe('two')
  expect(out.list).toEqual(['2.0.0'])
})
