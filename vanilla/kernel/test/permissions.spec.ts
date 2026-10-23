/**
 * Permission enforcement: Unix modes and owners, app capabilities and prompts, the folders an app may touch,
 * revocation, and the audit log.
 */
import { expect, test } from './fixtures'

/** Report what each attempt did: `ok` or the error code. Programs print this as JSON. */
const attempts = `
const results = {}
const attempt = async (label, fn) => { try { await fn(); results[label] = 'ok' } catch (e) { results[label] = e.code ?? String(e) } }
const enc = (s) => new TextEncoder().encode(s)
`

test('files have owners and modes, and a user process is held to them', async ({ page }) => {
  const out = await page.evaluate(async (attempts) => {
    const { kernel, sh } = window
    const put = async (path: string, text: string, mode: number, uid = 0, gid = 0) => {
      await kernel.writeFile(path, new TextEncoder().encode(text))
      await kernel.chmod(path, mode)
      await kernel.chown(path, uid, gid)
    }
    await kernel.mkdir('/data/private', { recursive: true })
    await kernel.chmod('/data/private', 0o700)
    await kernel.mkdir('/data/shared')
    await kernel.chown('/data/shared', 501, 20)
    await put('/data/private/secret.txt', 'secret', 0o644)
    await put('/data/public.txt', 'public', 0o644)
    await put('/data/group.txt', 'group', 0o660, 0, 20) // group staff: the user is a member
    await put('/data/shared/readonly.txt', 'ro', 0o444, 501, 20)
    await put('/data/shared/theirs.txt', 'root owns this', 0o644)
    await sh.install(
      '/Applications/user.js',
      `${attempts}
       export default async (t) => {
         const w = async (p, s = 'x') => t.writeFile(p, enc(s))
         await attempt('readPublic', () => t.readFile('/data/public.txt'))
         await attempt('readThroughClosedFolder', () => t.readFile('/data/private/secret.txt'))
         await attempt('listClosedFolder', () => t.readdir('/data/private'))
         await attempt('statThroughClosedFolder', () => t.stat('/data/private/secret.txt'))
         await attempt('writeOthers', () => w('/data/public.txt'))
         await attempt('createInRootFolder', () => w('/data/new.txt'))
         await attempt('readByGroup', () => t.readFile('/data/group.txt'))
         await attempt('writeByGroup', () => w('/data/group.txt'))
         await attempt('createInOwnFolder', () => w('/data/shared/mine.txt'))
         results.mine = await t.stat('/data/shared/mine.txt').then((s) => [s.uid, s.gid])
         await attempt('openReadOnlyForWrite', async () => t.close(await t.open('/data/shared/readonly.txt', 2)))
         await attempt('chmodOthers', () => t.chmod('/data/public.txt', 0o777))
         await attempt('chmodOwn', () => t.chmod('/data/shared/mine.txt', 0o600))
         await attempt('chownAway', () => t.chown('/data/shared/mine.txt', 0, -1))
         await attempt('chownGroupToOwn', () => t.chown('/data/shared/mine.txt', -1, 20))
         await attempt('chownGroupToOther', () => t.chown('/data/shared/mine.txt', -1, 99))
         await attempt('unlinkOthers', () => t.unlink('/data/public.txt'))
         await attempt('unlinkInOwnFolder', () => t.unlink('/data/shared/theirs.txt'))
         await attempt('renameOut', () => t.rename('/data/shared/mine.txt', '/data/mine.txt'))
         await attempt('mkdirDeep', () => t.mkdir('/data/shared/a/b/c', { recursive: true }))
         results.deep = await t.stat('/data/shared/a/b/c').then((s) => s.uid)
         await attempt('mkdirInRoot', () => t.mkdir('/data/x'))
         await attempt('symlinkInRoot', () => t.symlink('/data/public.txt', '/data/l'))
         await attempt('removeTreeNotOwned', () => t.removeAll('/data/private'))
         await attempt('copyIn', () => t.copy('/data/public.txt', '/data/shared/copy.txt'))
         results.copy = await t.stat('/data/shared/copy.txt').then((s) => s.uid)
         results.ids = [await t.getuid(), await t.getgid(), await t.getgroups(), await t.getappid()]
         console.log(JSON.stringify(results))
       }`,
    )
    const user = await sh.run('/Applications/user.js', { user: 'pear' })
    const asRoot = await sh.run('/Applications/user.js') // init's children are root: every attempt passes
    return { user: JSON.parse(user.stdout ?? ''), userStatus: user.code, root: JSON.parse(asRoot.stdout ?? '') }
  }, attempts)
  expect(out.userStatus).toBe(0)
  expect(out.user).toMatchObject({
    readPublic: 'ok',
    readThroughClosedFolder: 'EACCES',
    listClosedFolder: 'EACCES',
    statThroughClosedFolder: 'EACCES',
    writeOthers: 'EACCES',
    createInRootFolder: 'EACCES',
    readByGroup: 'ok',
    writeByGroup: 'ok',
    createInOwnFolder: 'ok',
    mine: [501, 20],
    openReadOnlyForWrite: 'EACCES',
    chmodOthers: 'EACCES',
    chmodOwn: 'ok',
    chownAway: 'EACCES',
    chownGroupToOwn: 'ok',
    chownGroupToOther: 'EACCES',
    unlinkOthers: 'EACCES',
    unlinkInOwnFolder: 'ok', // the folder is theirs, whoever owns the file
    renameOut: 'EACCES',
    mkdirDeep: 'ok',
    deep: 501,
    mkdirInRoot: 'EACCES',
    symlinkInRoot: 'EACCES',
    removeTreeNotOwned: 'EACCES',
    copyIn: 'ok',
    copy: 501,
    ids: [501, 20, [20], null],
  })
  expect(Object.values(out.root).filter((v) => v === 'EACCES' || v === 'EPERM')).toEqual([])
})

test('a sticky folder lets you remove only your own files', async ({ page }) => {
  const out = await page.evaluate(async (attempts) => {
    const { kernel, sh } = window
    await kernel.writeFile('/tmp/rootfile', new TextEncoder().encode('x'))
    await sh.install(
      '/Applications/sticky.js',
      `${attempts}
       export default async (t) => {
         await t.writeFile('/tmp/mine', enc('x'))
         await attempt('createPlain', () => t.stat('/tmp/mine'))
         await attempt('removeRoots', () => t.unlink('/tmp/rootfile'))
         await attempt('renameRoots', () => t.rename('/tmp/rootfile', '/tmp/moved'))
         await attempt('removeMine', () => t.unlink('/tmp/mine'))
         console.log(JSON.stringify(results))
       }`,
    )
    return { r: JSON.parse((await sh.run('/Applications/sticky.js', { user: 'pear' })).stdout ?? ''), still: await kernel.exists('/tmp/rootfile') }
  }, attempts)
  expect(out.r).toEqual({ createPlain: 'ok', removeRoots: 'EACCES', renameRoots: 'EACCES', removeMine: 'ok' })
  expect(out.still).toBe(true)
})

test('only root may choose another user or bundle for a process', async ({ page }) => {
  const out = await page.evaluate(async (attempts) => {
    const { kernel, sh } = window
    await sh.install('/Applications/idle.js', `export default () => 0`)
    await sh.install(
      '/Applications/climb.js',
      `${attempts}
       export default async (t) => {
         await attempt('asRoot', async () => t.wait(await t.spawn('/Applications/idle.js', { user: 'root' })))
         await attempt('asBundle', async () => t.wait(await t.spawn('/Applications/idle.js', { bundle: { id: 'com.x.y', kind: 'app', trusted: true } })))
         await attempt('plainChild', async () => t.wait(await t.spawn('/Applications/idle.js')))
         await attempt('killRoot', () => t.kill(Number(t.args[0])))
         await attempt('unknownUser', () => t.spawn('/Applications/idle.js', { user: 'nobody-here' }))
         console.log(JSON.stringify(results))
       }`,
    )
    await sh.install('/Applications/rootproc.js', `export default async () => { await new Promise(() => {}) }`)
    const rootPid = await kernel.spawn('/Applications/rootproc.js')
    const r = JSON.parse((await sh.run('/Applications/climb.js', { user: 'pear', args: [String(rootPid)] })).stdout ?? '')
    const alive = (await kernel.processInfo(rootPid)).state
    await kernel.kill(rootPid)
    return { r, alive }
  }, attempts)
  expect(out.r).toEqual({ asRoot: 'EPERM', asBundle: 'EPERM', plainChild: 'ok', killRoot: 'EPERM', unknownUser: 'EPERM' })
  expect(out.alive).toBe('running')
})

test('capabilities: declared ones prompt, undeclared ones are denied, and the answer is remembered', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.app(
      'com.example.cap',
      `export default async (t) => {
         const r = {
           clipboard: await t.permCheck('clipboard'),
           network: await t.permCheck('network'),
           container: await t.permCheck('fs.container'),
           bad: await t.permCheck('nope').catch((e) => e.code),
           askNetwork: await t.permRequest('network'),
           askClipboard: await t.permRequest('clipboard'),
           again: await t.permCheck('clipboard'),
           list: (await t.permList()).map((g) => g.capability + ':' + g.status),
         }
         console.log(JSON.stringify(r))
       }`,
      { permissions: ['clipboard', 'notifications'] },
    )
    const run = async () => JSON.parse((await kernel.wait(await kernel.launchOpen('com.example.cap'))).stdout ?? '')
    const noPrompter = await run() // nobody can show a prompt: requests are denied, and not remembered
    const afterNoPrompter = await kernel.permStatus('com.example.cap', 'clipboard')

    await kernel.permSetPrompter(true)
    const prompts: string[] = []
    kernel.onEvent((e) => {
      if (e.type === 'permission' && e.event === 'prompt') {
        prompts.push(`${e.appId}:${e.appName}:${e.capability}`)
        void kernel.permRespond(e.id, 'granted')
      }
    })
    const withPrompter = await run()
    await kernel.permSetPrompter(false)
    const list = await kernel.permList('com.example.cap')

    await kernel.permRevoke('com.example.cap', 'clipboard')
    const revoked = await kernel.permStatus('com.example.cap', 'clipboard')
    await sh.sleep(300)
    const fileAfterRevoke = JSON.parse(await sh.cat('/var/db/permissions.json'))
    await kernel.permSetPrompter(true)
    const stays = (await run()).askClipboard // a decision stands until reset
    await kernel.permReset('com.example.cap', 'clipboard')
    const reset = await kernel.permStatus('com.example.cap', 'clipboard')
    const undeclared = await kernel.permGrant('com.example.cap', 'network').then(() => 'ok', (e) => e.code)
    await sh.sleep(300)
    const file = JSON.parse(await sh.cat('/var/db/permissions.json'))
    return { noPrompter, afterNoPrompter, withPrompter, prompts, list, revoked, fileAfterRevoke, stays, reset, undeclared, file }
  })
  expect(out.noPrompter).toMatchObject({ clipboard: 'prompt', network: 'denied', container: 'granted', bad: 'EINVAL', askNetwork: 'denied', askClipboard: 'denied', again: 'prompt' })
  expect(out.afterNoPrompter).toBe('prompt')
  expect(out.withPrompter).toMatchObject({ askNetwork: 'denied', askClipboard: 'granted', again: 'granted' })
  expect(out.withPrompter.list).toEqual(['fs.container:granted', 'clipboard:granted', 'notifications:prompt'])
  expect(out.prompts).toEqual(['com.example.cap:cap:clipboard'])
  expect(out.list.map((g) => `${g.capability}:${g.status}`)).toEqual(['fs.container:granted', 'clipboard:granted', 'notifications:prompt'])
  expect(out.revoked).toBe('denied')
  expect(out.stays).toBe('denied')
  expect(out.reset).toBe('prompt')
  expect(out.undeclared).toBe('EPERM')
  // decisions are stored; forgetting one removes it
  expect(out.fileAfterRevoke).toEqual([expect.objectContaining({ appId: 'com.example.cap', capability: 'clipboard', status: 'denied' })])
  expect(out.file.map((g: { appId: string; capability: string; status: string }) => `${g.appId} ${g.capability} ${g.status}`)).toEqual([])
})

test('a prompt that loses its handler is denied', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.app(
      'com.example.wait',
      `export default async (t) => { console.log(await t.permRequest('location')) }`,
      { permissions: ['location'] },
    )
    await kernel.permSetPrompter(true)
    const seen: number[] = []
    kernel.onEvent((e) => e.type === 'permission' && e.event === 'prompt' && seen.push(e.id))
    const pid = await kernel.launchOpen('com.example.wait')
    for (let i = 0; i < 100 && !seen.length; i++) await sh.sleep(20)
    await kernel.permSetPrompter(false)
    const status = await kernel.wait(pid)
    const late = await kernel.permRespond(seen[0]!, 'granted').then(() => 'ok', (e) => e.code)
    return { prompts: seen.length, answer: status.stdout, late, now: await kernel.permStatus('com.example.wait', 'location') }
  })
  expect(out).toEqual({ prompts: 1, answer: 'denied\n', late: 'ENOENT', now: 'prompt' })
})

test('an app is confined to its container, the shared folders, and what the user granted', async ({ page }) => {
  const out = await page.evaluate(async (attempts) => {
    const { kernel, sh } = window
    for (const d of ['/Users/pear/Documents', '/Users/pear/Private']) {
      await kernel.mkdir(d, { recursive: true })
      await kernel.chown(d, 501, 20)
    }
    const put = (p: string, t: string) => kernel.writeFile(p, new TextEncoder().encode(t))
    await put('/Users/pear/Documents/x.txt', 'documents')
    await kernel.chown('/Users/pear/Documents/x.txt', 501, 20)
    await put('/Users/pear/Private/pick.txt', 'picked')
    await put('/Users/pear/Private/other.txt', 'other')
    await put('/tmp/shared.txt', 'tmp')
    await sh.app(
      'com.example.scope',
      `${attempts}
       export default async (t) => {
         const id = 'com.example.scope'
         const container = '/Users/pear/Library/Containers/' + id
         await attempt('ownContainer', () => t.writeFile(container + '/f', enc('x')))
         await attempt('supportDir', () => t.writeFile('/Users/pear/Library/Application Support/' + id + '/f', enc('x')))
         await attempt('readDocs', () => t.readFile('/Users/pear/Documents/x.txt'))
         await attempt('existsDocs', () => t.exists('/Users/pear/Documents/x.txt'))
         await attempt('listHome', () => t.readdir('/Users/pear'))
         await attempt('statHome', () => t.stat('/Users/pear'))
         await attempt('dotDot', () => t.readFile(container + '/../../../Documents/x.txt'))
         await attempt('otherContainer', () => t.readdir('/Users/pear/Library/Containers/com.example.other'))
         await attempt('tmpWrite', () => t.writeFile('/tmp/from-app', enc('x')))
         await attempt('tmpRead', () => t.readFile('/tmp/shared.txt'))
         await attempt('ownBundle', () => t.readFile('/Applications/scope.app/main.js'))
         await attempt('ownBundleWrite', () => t.writeFile('/Applications/scope.app/main.js', enc('x')))
         await attempt('applications', () => t.writeFile('/Applications/other.js', enc('x')))
         await attempt('root', () => t.stat('/'))
         await t.unlink(container + '/link').catch(() => {})
         await t.symlink('/Users/pear/Documents/x.txt', container + '/link')
         await attempt('throughLink', () => t.readFile(container + '/link'))
         await attempt('picked', () => t.readFile('/Users/pear/Private/pick.txt'))
         await attempt('pickedWrite', () => t.writeFile('/Users/pear/Private/pick.txt', enc('x')))
         await attempt('notPicked', () => t.readFile('/Users/pear/Private/other.txt'))
         await attempt('chmodOutside', () => t.chmod('/Users/pear/Documents/x.txt', 0o600))
         console.log(JSON.stringify(results))
       }`,
      { permissions: ['fs.user'] },
    )
    const run = async () => JSON.parse((await kernel.wait(await kernel.launchOpen('com.example.scope'))).stdout ?? '')
    await kernel.mkdir('/Users/pear/Library/Containers/com.example.other', { recursive: true })
    const confined = await run()
    await kernel.permPickerGrant('com.example.scope', '/Users/pear/Private/pick.txt', { write: false })
    const picked = await run()
    await kernel.permGrant('com.example.scope', 'fs.user')
    const granted = await run()
    const afterExit = await run().then(() => null)
    return { confined, picked, granted, afterExit }
  }, attempts)
  const denied = 'EACCES'
  expect(out.confined).toEqual({
    ownContainer: 'ok', supportDir: 'ok',
    readDocs: denied, existsDocs: denied, listHome: denied, statHome: 'ok', dotDot: denied, otherContainer: denied,
    tmpWrite: 'ok', tmpRead: 'ok', ownBundle: 'ok', ownBundleWrite: denied, applications: denied, root: 'ok',
    throughLink: denied, picked: denied, pickedWrite: denied, notPicked: denied, chmodOutside: denied,
  })
  // a picked file: that file only, and read-only if the picker said so
  expect(out.picked).toMatchObject({ readDocs: denied, picked: 'ok', pickedWrite: denied, notPicked: denied })
  // fs.user opens the home folder (the modes still apply: the user owns it)
  expect(out.granted).toMatchObject({ readDocs: 'ok', existsDocs: 'ok', listHome: 'ok', throughLink: 'ok', chmodOutside: 'ok', otherContainer: 'ok', dotDot: 'ok' })
  expect(out.afterExit).toBeNull()
})

test('revoking a permission closes the files it covered', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await kernel.mkdir('/Users/pear/Documents', { recursive: true })
    await kernel.writeFile('/Users/pear/Documents/x.txt', new TextEncoder().encode('documents'))
    await sh.app(
      'com.example.hold',
      `export default async (t) => {
         const fd = await t.open('/Users/pear/Documents/x.txt', 0)
         const tmp = await t.open('/tmp/hold-tmp', 0x1 | 0x40)
         const before = new TextDecoder().decode(await t.read(fd, 100))
         await t.writeFile('/tmp/opened', new Uint8Array(1))
         while (!(await t.exists('/tmp/go'))) await new Promise((r) => setTimeout(r, 10))
         const after = await t.read(fd, 100).then(() => 'still readable', (e) => e.code)
         const other = await t.write(tmp, new Uint8Array([1])).then(() => 'still writable', (e) => e.code)
         const reopen = await t.open('/Users/pear/Documents/x.txt', 0).then(() => 'opened', (e) => e.code)
         console.log(JSON.stringify({ before, after, other, reopen }))
       }`,
      { permissions: ['fs.user'] },
      true,
    )
    const pid = await kernel.launchOpen('com.example.hold')
    await sh.waitFor('/tmp/opened')
    await kernel.permRevoke('com.example.hold', 'fs.user')
    await kernel.writeFile('/tmp/go', new Uint8Array(1))
    return JSON.parse((await kernel.wait(pid)).stdout ?? '')
  })
  expect(out).toEqual({ before: 'documents', after: 'EBADF', other: 'still writable', reopen: 'EACCES' })
})

test('process.spawn is a capability, and children stay confined; apps cannot signal other apps', async ({ page }) => {
  const out = await page.evaluate(async (attempts) => {
    const { kernel, sh } = window
    await kernel.mkdir('/Users/pear/Documents', { recursive: true })
    await kernel.writeFile('/Users/pear/Documents/x.txt', new TextEncoder().encode('documents'))
    await sh.install(
      '/tmp/child.js',
      `${attempts}
       export default async (t) => {
         await attempt('childReadsDocs', () => t.readFile('/Users/pear/Documents/x.txt'))
         results.appId = await t.getappid()
         console.log(JSON.stringify(results))
       }`,
    )
    await kernel.chmod('/tmp/child.js', 0o644)
    await sh.app('com.example.victim', `export default async () => { await new Promise(() => {}) }`)
    const victim = await kernel.launchOpen('com.example.victim')
    const body = (arg: string) => `${attempts}
       export default async (t) => {
         await attempt('spawn', async () => { const pid = await t.spawn('/tmp/child.js'); results.child = JSON.parse((await t.wait(pid)).stdout) })
         await attempt('killOtherApp', () => t.kill(${arg}))
         console.log(JSON.stringify(results))
       }`
    await sh.app('com.example.nospawn', body(String(victim)), {})
    await sh.app('com.example.spawner', body(String(victim)), { permissions: ['process.spawn'] }, true)
    const run = async (id: string) => (await kernel.wait(await kernel.launchOpen(id))).stdout ?? ''
    const a = await run('com.example.nospawn')
    const b = await run('com.example.spawner')
    const alive = (await kernel.processInfo(victim)).state
    await kernel.kill(victim)
    return { a, b, alive }
  }, attempts)
  expect(JSON.parse(out.a)).toEqual({ spawn: 'EPERM', killOtherApp: 'EPERM' })
  expect(JSON.parse(out.b)).toEqual({
    spawn: 'ok',
    child: { childReadsDocs: 'EACCES', appId: 'com.example.spawner' }, // the child is confined like its parent
    killOtherApp: 'EPERM',
  })
  expect(out.alive).toBe('running')
})

test('refusals are audited, in memory and in /var/log/audit.log', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await kernel.mkdir('/Users/pear/Documents', { recursive: true })
    await sh.app(
      'com.example.audit',
      `export default async (t) => {
         await t.readFile('/Users/pear/Documents/x.txt').catch(() => {})
         await t.permRequest('clipboard')
       }`,
      { permissions: ['clipboard'] },
    )
    await kernel.wait(await kernel.launchOpen('com.example.audit'))
    await kernel.permGrant('com.example.audit', 'clipboard')
    await kernel.permRevoke('com.example.audit', 'clipboard')
    const recent = await kernel.permAudit()
    await sh.sleep(500)
    const lines = (await sh.cat('/var/log/audit.log')).trim().split('\n').map((l) => JSON.parse(l))
    return { recent, lines }
  })
  const summary = (e: { event: string; appId: string | null; call?: string; capability?: string; path?: string }) =>
    `${e.event} ${e.appId} ${e.call ?? ''} ${e.capability ?? ''} ${e.path ?? ''}`.replace(/\s+/g, ' ').trim()
  expect(out.recent.map(summary)).toEqual([
    'fs-denied com.example.audit readFile /Users/pear/Documents/x.txt',
    'deny com.example.audit clipboard',
    'grant com.example.audit clipboard',
    'deny com.example.audit clipboard',
    'revoke com.example.audit clipboard',
  ])
  expect(out.lines.map(summary)).toEqual(out.recent.map(summary))
  expect(out.recent[0]!.time).toBeGreaterThan(0)
})
