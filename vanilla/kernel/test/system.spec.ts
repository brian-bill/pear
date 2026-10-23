/** The boot sequence and the system services (processes registered by name). */
import { expect, test } from './fixtures'

test.use({ system: true })

test('first boot creates the hierarchy, users, userland and services', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const st = async (p: string) => {
      const s = await kernel.stat(p)
      return `${s.uid}:${s.gid}:${s.mode.toString(8)}`
    }
    const info = await kernel.bootInfo()
    const dirs: Record<string, string> = {}
    for (const d of ['/System', '/System/Applications', '/Applications', '/bin', '/etc', '/tmp', '/var/log', '/var/db', '/var/root', '/Users', '/Users/pear', '/Users/pear/Documents', '/Users/pear/Library/Containers', '/Users/pear/.Trash']) dirs[d] = await st(d)
    const procs = (await kernel.listProcesses()).filter((p) => p.state === 'running')
    return {
      info, dirs,
      passwd: await sh.cat('/etc/passwd'), group: await sh.cat('/etc/group'),
      bin: [await st('/bin/ls'), await st('/bin/sh')],
      bundles: (await kernel.bundleList()).map((b) => `${b.id} ${b.kind} ${b.path} system=${b.system}`),
      procs: procs.map((p) => `${p.bundleId} ${p.kind} uid=${p.uid} app=${p.appId}`).sort(),
      apps: await kernel.launchApps(),
      marker: await kernel.exists('/var/db/.session'),
    }
  })
  expect(out.info).toMatchObject({ firstBoot: true, previousShutdown: 'clean', version: '1.0', warnings: [] })
  expect(out.info.services.sort()).toEqual(['tiny.audio', 'tiny.clipboard', 'tiny.display', 'tiny.input', 'tiny.launch', 'tiny.network', 'tiny.notifications', 'tiny.registry', 'tiny.search', 'tiny.session', 'tiny.settings', 'tiny.system', 'tiny.timers'])
  expect(out.dirs).toEqual({
    '/System': '0:0:755', '/System/Applications': '0:0:755', '/Applications': '0:0:755', '/bin': '0:0:755', '/etc': '0:0:755',
    '/tmp': '0:0:1777', '/var/log': '0:0:755', '/var/db': '0:0:755', '/var/root': '0:0:700',
    '/Users': '0:0:755', '/Users/pear': '501:20:755', '/Users/pear/Documents': '501:20:755',
    '/Users/pear/Library/Containers': '501:20:755', '/Users/pear/.Trash': '501:20:700',
  })
  expect(out.passwd).toBe('root:x:0:0:/var/root\npear:x:501:20:/Users/pear\n')
  expect(out.group).toBe('wheel:x:0:root\nstaff:x:20:pear\n')
  expect(out.bin).toEqual(['0:0:755', '0:0:755'])
  expect(out.bundles.sort()).toEqual([
    'org.tiny.driver.audio service /System/Applications/Audio Driver.app system=true',
    'org.tiny.driver.clipboard service /System/Applications/Clipboard Driver.app system=true',
    'org.tiny.driver.display service /System/Applications/Display Driver.app system=true',
    'org.tiny.driver.input service /System/Applications/Input Driver.app system=true',
    'org.tiny.driver.timers service /System/Applications/Timer Driver.app system=true',
    'org.tiny.service.launch service /System/Applications/Launch Service.app system=true',
    'org.tiny.service.network service /System/Applications/Network Service.app system=true',
    'org.tiny.service.notifications service /System/Applications/Notification Service.app system=true',
    'org.tiny.service.registry service /System/Applications/App Registry.app system=true',
    'org.tiny.service.search service /System/Applications/Search Service.app system=true',
    'org.tiny.service.session service /System/Applications/Session Service.app system=true',
    'org.tiny.service.settings service /System/Applications/Settings Service.app system=true',
    'org.tiny.service.system service /System/Applications/System Info Service.app system=true',
  ])
  // system services are trusted: root, not confined to an app
  expect(out.procs).toEqual([
    'org.tiny.driver.audio service uid=0 app=null',
    'org.tiny.driver.clipboard service uid=0 app=null',
    'org.tiny.driver.display service uid=0 app=null',
    'org.tiny.driver.input service uid=0 app=null',
    'org.tiny.driver.timers service uid=0 app=null',
    'org.tiny.service.launch service uid=0 app=null',
    'org.tiny.service.network service uid=0 app=null',
    'org.tiny.service.notifications service uid=0 app=null',
    'org.tiny.service.registry service uid=0 app=null',
    'org.tiny.service.search service uid=0 app=null',
    'org.tiny.service.session service uid=0 app=null',
    'org.tiny.service.settings service uid=0 app=null',
    'org.tiny.service.system service uid=0 app=null',
  ])
  expect(out.apps).toEqual([]) // services are not apps
  expect(out.marker).toBe(true)
})

test('the shell works as the user right after boot, and the user cannot touch the system', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const dec = new TextDecoder()
    const { pid, master } = await kernel.spawnPty('/bin/sh', { user: 'pear', cwd: '/Users/pear', env: { PS1: '', PS2: '' } })
    await kernel.tcsetattr(master, { echo: false })
    await kernel.pipeWrite(master, 'echo hi > Documents/a.txt\nls -l Documents\ncat /etc/passwd | head -n 1\necho x > /System/y\necho "code=$?"\nexit\n')
    let text = ''
    for (;;) {
      const chunk = await kernel.pipeRead(master)
      if (!chunk.length) break
      text += dec.decode(chunk, { stream: true })
    }
    await kernel.wait(pid)
    return { text, owner: await kernel.stat('/Users/pear/Documents/a.txt') }
  })
  expect(out.owner).toMatchObject({ uid: 501, gid: 20 })
  expect(out.text).toContain('root:x:0:0')
  expect(out.text).toMatch(/denied|EACCES/i)
  expect(out.text).toContain('code=1')
})

test('a second boot finds what the first left; a session that was not shut down is reported as a crash', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    await kernel.configSet('tiny.test', 'k', 'v')
    await kernel.writeFile('/Users/pear/Documents/keep.txt', new TextEncoder().encode('keep'))
    const first = await kernel.bootInfo()
    const pidsBefore = (await kernel.listProcesses()).map((p) => p.bundleId).sort()

    // clean shutdown, then boot the same storage again in the same worker
    await kernel.shutdown()
    await kernel.boot({ namespace: ns, system: true })
    const clean = await kernel.bootInfo()
    const afterClean = {
      docs: new TextDecoder().decode(await kernel.readFile('/Users/pear/Documents/keep.txt')),
      config: await kernel.configGet('tiny.test', 'k'),
      bundles: (await kernel.bundleList()).length,
      pids: (await kernel.listProcesses()).map((p) => p.bundleId).sort(),
    }

    // a crash: the Worker is killed with no shutdown
    await sh.crash(ns, { system: true })
    const crashed = await window.kernel.bootInfo()
    const afterCrash = {
      docs: new TextDecoder().decode(await window.kernel.readFile('/Users/pear/Documents/keep.txt')),
      config: await window.kernel.configGet('tiny.test', 'k'),
      bundles: (await window.kernel.bundleList()).length,
      pids: (await window.kernel.listProcesses()).map((p) => p.bundleId).sort(),
    }
    return { first, pidsBefore, clean, afterClean, crashed, afterCrash }
  }, ns)
  expect(out.first.firstBoot).toBe(true)
  expect(out.clean).toMatchObject({ firstBoot: false, previousShutdown: 'clean', warnings: [] })
  expect(out.afterClean.docs).toBe('keep')
  expect(out.afterClean.config).toBe('v')
  expect(out.afterClean.bundles).toBe(13) // not installed twice
  expect(out.afterClean.pids).toEqual(out.pidsBefore)
  expect(out.clean.services).toHaveLength(13)
  expect(out.crashed).toMatchObject({ firstBoot: false, previousShutdown: 'crash', warnings: [] })
  expect(out.crashed.services).toHaveLength(13)
  expect(out.afterCrash).toEqual({ docs: 'keep', config: 'v', bundles: 13, pids: out.pidsBefore })
})

test('the settings service: get, set with the caller\'s rights, and change notifications', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const svc = await kernel.lookup('tiny.settings')
    const ask = async (req: object, rights?: number[]) => (await kernel.request(svc, req, { rights, timeout: 5000 })).data as { ok: boolean; result?: unknown; error?: { code: string } }

    const set = await ask({ op: 'set', domain: 'tiny.test', key: 'a', value: { n: 1 } })
    const get = await ask({ op: 'get', domain: 'tiny.test', key: 'a' })
    const list = await ask({ op: 'list', domain: 'tiny.test' })
    const invalid = await ask({ op: 'set', domain: 'tiny.system', key: 'appearance', value: 'purple' })
    const unknownOp = await ask({ op: 'frobnicate' })
    const direct = await kernel.configGet('tiny.test', 'a')

    const inbox = await kernel.portCreate()
    const watch = await ask({ op: 'watch', domain: 'tiny.test', key: 'a' }, [inbox])
    const noPort = await ask({ op: 'watch', domain: 'tiny.test' })
    await kernel.configSet('tiny.test', 'other', 1) // a different key
    await kernel.configSet('tiny.test', 'a', 2)
    const event = (await kernel.receive(inbox, { timeout: 5000 })).data

    // an app may change only its own domain, through the service as well
    await sh.app(
      'com.example.viaservice',
      `export default async (t) => {
         const svc = await t.lookup('tiny.settings')
         const ask = async (req) => (await t.request(svc, req, { timeout: 5000 })).data
         const r = {
           own: (await ask({ op: 'set', domain: 'com.example.viaservice', key: 'k', value: 1 })).ok,
           other: (await ask({ op: 'set', domain: 'tiny.test', key: 'a', value: 99 })).error?.code,
           system: (await ask({ op: 'set', domain: 'com.example.viaservice', key: 'k', value: 1, scope: 'system' })).error?.code,
           read: (await ask({ op: 'get', domain: 'tiny.test', key: 'a' })).result,
         }
         console.log(JSON.stringify(r))
       }`,
    )
    const app = JSON.parse((await kernel.wait(await kernel.launchOpen('com.example.viaservice'))).stdout ?? '')
    return { set, get, list, invalid, unknownOp, direct, watch, noPort, event, app, after: await kernel.configGet('tiny.test', 'a') }
  })
  expect(out.set).toEqual({ ok: true, result: null })
  expect(out.get).toEqual({ ok: true, result: { n: 1 } })
  expect(out.list.result).toEqual({ a: { n: 1 } })
  expect(out.invalid.error?.code).toBe('EINVAL')
  expect(out.unknownOp.error?.code).toBe('ENOSYS')
  expect(out.direct).toEqual({ n: 1 })
  expect(out.watch.ok).toBe(true)
  expect(out.noPort.error?.code).toBe('EINVAL')
  expect(out.event).toMatchObject({ type: 'changed', change: { type: 'config-changed', domain: 'tiny.test', key: 'a', value: 2 } })
  expect(out.app).toEqual({ own: true, other: 'EACCES', system: 'EACCES', read: 2 })
  expect(out.after).toBe(2)
})

test('the notification service: posting needs the permission; subscribers hear about it', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const svc = await kernel.lookup('tiny.notifications')
    const ask = async (req: object, rights?: number[]) => (await kernel.request(svc, req, { rights, timeout: 5000 })).data as { ok: boolean; result?: any; error?: { code: string } }
    const inbox = await kernel.portCreate()
    await ask({ op: 'subscribe' }, [inbox])

    const post = (title: string) => `(await ask({ op: 'post', title: ${JSON.stringify(title)}, body: 'body' }))`
    const program = `export default async (t) => {
        const svc = await t.lookup('tiny.notifications')
        const ask = async (req) => (await t.request(svc, req, { timeout: 5000 })).data
        const r = { first: ${post('hello')}, long: (await ask({ op: 'post', title: 'x'.repeat(300) })).error?.code }
        r.mine = (await ask({ op: 'list' })).result.map((n) => n.title)
        console.log(JSON.stringify(r))
      }`
    await sh.app('com.example.notify', program, { permissions: ['notifications'] })
    await sh.app('com.example.silent', program, {})
    const run = async (id: string) => JSON.parse((await kernel.wait(await kernel.launchOpen(id))).stdout ?? '')
    const silent = await run('com.example.silent') // never declared it: denied
    const denied = (silent.first as { error: { code: string } }).error.code
    const before = (await ask({ op: 'list' })).result.length // nothing posted by the silent app
    await kernel.permGrant('com.example.notify', 'notifications')
    const loud = await run('com.example.notify')

    const heard = (await kernel.receive(inbox, { timeout: 5000 })).data as { type: string; notification: { id: number; appId: string; title: string } }
    const fromDesktop = await ask({ op: 'post', title: 'from the system' })
    const list = (await ask({ op: 'list' })).result as Array<{ id: number; appId: string | null; title: string }>
    const dismissed = await ask({ op: 'dismiss', id: heard.notification.id })
    const events = [(await kernel.receive(inbox, { timeout: 5000 })).data, (await kernel.receive(inbox, { timeout: 5000 })).data] as Array<{ type: string; id?: number; notification?: { title: string } }>
    const gone = await ask({ op: 'dismiss', id: heard.notification.id })
    return { denied, before, loud, heard, fromDesktop, list: list.map((n) => `${n.appId} ${n.title}`), dismissed, events, gone }
  })
  expect(out.denied).toBe('EPERM')
  expect(out.before).toBe(0)
  expect(out.loud.first).toEqual({ ok: true, result: expect.any(Number) })
  expect(out.loud.long).toBe('EINVAL')
  expect(out.loud.mine).toEqual(['hello'])
  expect(out.heard).toMatchObject({ type: 'posted', notification: { appId: 'com.example.notify', title: 'hello' } })
  expect(out.list).toEqual(['com.example.notify hello', 'null from the system'])
  expect(out.dismissed).toEqual({ ok: true, result: true })
  expect(out.events.map((e) => e.type)).toEqual(['posted', 'dismissed']) // the desktop's own post, then the dismissal
  expect(out.gone).toEqual({ ok: true, result: false })
})

test('the launch and registry services open and list for callers, with the caller\'s rights', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await kernel.chown('/Users/pear/Documents', 501, 20)
    await kernel.writeFile('/Users/pear/Documents/secret.txt', new TextEncoder().encode('secret'))
    await kernel.chown('/Users/pear/Documents/secret.txt', 501, 20)
    await sh.app('com.example.reader', `export default async (t) => { await t.writeFile('seen.txt', new TextEncoder().encode(new TextDecoder().decode(await t.readFile(t.args[0])))) }`, { documentTypes: [{ ext: ['txt'], role: 'viewer' }] })
    await sh.app(
      'com.example.asker',
      `export default async (t) => {
         const launch = await t.lookup('tiny.launch')
         const registry = await t.lookup('tiny.registry')
         const ask = async (port, req) => (await t.request(port, req, { timeout: 5000 })).data
         const r = {
           apps: (await ask(registry, { op: 'list' })).result.filter((b) => b.kind === 'app').map((b) => b.id).sort(),
           type: (await ask(registry, { op: 'typeOf', path: '/Applications' })).result?.uti,
           openSecret: (await ask(launch, { op: 'open', target: '/Users/pear/Documents/secret.txt' })).error?.code,
           setDefault: (await ask(launch, { op: 'setDefault', type: 'public.plain-text', app: 'com.example.reader' })).error?.code,
         }
         console.log(JSON.stringify(r))
       }`,
    )
    const asker = JSON.parse((await kernel.wait(await kernel.launchOpen('com.example.asker'))).stdout ?? '')
    // the same request from Desktop (root) works, and the app that opens the file may read it
    const svc = await kernel.lookup('tiny.launch')
    const opened = (await kernel.request(svc, { op: 'open', target: '/Users/pear/Documents/secret.txt' }, { timeout: 5000 })).data as { ok: boolean; result: number }
    await kernel.wait(opened.result)
    const reg = (await kernel.request(await kernel.lookup('tiny.registry'), { op: 'appsFor', target: '/Users/pear/Documents/secret.txt' }, { timeout: 5000 })).data as { result: Array<{ id: string }> }
    const running = (await kernel.request(svc, { op: 'running' }, { timeout: 5000 })).data as { result: unknown[] }
    return { asker, opened: opened.ok, seen: await sh.cat('/Users/pear/Library/Containers/com.example.reader/seen.txt'), appsFor: reg.result.map((a) => a.id), running: running.result.length }
  })
  // an app cannot use the launch service to read what it could not read itself, nor change the user's choices
  expect(out.asker).toEqual({ apps: ['com.example.asker', 'com.example.reader'], type: 'public.folder', openSecret: 'EACCES', setDefault: 'EPERM' })
  expect(out.opened).toBe(true)
  expect(out.seen).toBe('secret')
  expect(out.appsFor).toEqual(['com.example.reader'])
})
