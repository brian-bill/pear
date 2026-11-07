/**
 * Console apps: bundles that declare `commands` and `service`. Registration through shims, development links,
 * conflicts, identity, and service supervision (see contracts/console-apps.md).
 */
import { expect, test } from './fixtures'

const HELLO = `export default async (tiny) => { await tiny.stdout.write('hello ' + tiny.args.join('|') + ' id=' + (await tiny.environ()).TINY_APP_ID); return 7 }`

declare global {
  interface Window {
    tool(id: string, commands: unknown[], extra?: Record<string, unknown>, files?: Record<string, string>): Promise<import('../src/bundle').BundleInfo>
  }
}

test.beforeEach(async ({ page }) => {
  await page.evaluate((hello) => {
    window.tool = (id, commands, extra = {}, files = {}) =>
      window.kernel.bundleInstall({
        files: { 'manifest.json': JSON.stringify({ id, name: id.split('.').pop(), version: '1.0.0', kind: 'tool', entry: 'main.js', commands, ...extra }), 'main.js': hello, ...files },
      })
  }, HELLO)
})

test('the manifest validates commands and the service section', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const bad = (extra: object, files: Record<string, string> = {}) =>
      kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.bad', name: 'bad', version: '1.0.0', kind: 'tool', ...extra }), 'main.js': 'export default () => 0', ...files } }).then(() => 'installed', (e) => `${e.code}`)
    return {
      slash: await bad({ commands: ['a/b'] }),
      dash: await bad({ commands: ['-x'] }),
      dot: await bad({ commands: ['.x'] }),
      dupes: await bad({ commands: ['a', { name: 'a' }] }),
      missing: await bad({ commands: [{ name: 'a', entry: 'nope.js' }] }),
      tooMany: await bad({ commands: Array.from({ length: 33 }, (_, i) => `c${i}`) }),
      notList: await bad({ commands: 'x' }),
      serviceOnTool: await bad({ service: { name: 'a.b' } }),
      badRestart: await bad({ kind: 'service', service: { name: 'a.b', restart: 'sometimes' } }),
      ok: await bad({ commands: ['fine-1', { name: 'b.c', summary: 'x' }] }),
    }
  })
  expect({ ...out, ok: undefined }).toEqual({
    slash: 'EINVAL', dash: 'EINVAL', dot: 'EINVAL', dupes: 'EINVAL', missing: 'EINVAL', tooMany: 'EINVAL', notList: 'EINVAL', serviceOnTool: 'EINVAL', badRestart: 'EINVAL', ok: undefined,
  })
  expect(out.ok).toBe('installed')
})

test('installing writes shims; the command runs as the bundle with argv [name, ...args]; uninstall removes them', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, tool } = window
    await tool('org.test.hello', [{ name: 'hello', summary: 'Say hi' }, 'hello2'])
    const shim = await sh.cat('/usr/local/bin/hello')
    const mode = (await kernel.stat('/usr/local/bin/hello')).mode & 0o777
    const st = await sh.run('/usr/local/bin/hello', { args: ['a', 'b c'] })
    const list = await kernel.commandList()
    const resolved = await kernel.commandResolve('hello2')
    await kernel.bundleUninstall('org.test.hello')
    return { shim, mode, code: st.code, stdout: st.stdout, list, resolved, gone: await kernel.exists('/usr/local/bin/hello'), after: await kernel.commandList() }
  })
  expect(out.shim).toBe('#!pear-command org.test.hello hello\n')
  expect(out.mode).toBe(0o755)
  expect(out.code).toBe(7)
  expect(out.stdout).toBe('hello hello|a|b c id=org.test.hello')
  expect(out.list.map((c) => [c.name, c.summary, c.owner])).toEqual([
    ['hello', 'Say hi', { kind: 'bundle', id: 'org.test.hello' }],
    ['hello2', null, { kind: 'bundle', id: 'org.test.hello' }],
  ])
  expect(out.resolved?.entry).toBe('/Applications/hello.app/main.js')
  expect(out.gone).toBe(false)
  expect(out.after).toEqual([])
})

test('a system program name is refused; a name held by another bundle stays with the first', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, tool } = window
    await sh.installUserland()
    const system = await tool('org.test.ls', ['ls']).then(() => 'installed', (e) => e.code)
    const left = await kernel.exists('/Applications/ls.app')
    await tool('org.test.first', ['dup'])
    await tool('org.test.second', ['dup', 'other'])
    const owner = (await kernel.commandResolve('dup'))?.owner
    const conflicts = await kernel.commandConflicts()
    const before = await sh.cat('/usr/local/bin/dup')
    await kernel.commandTakeOver('dup', 'org.test.second')
    return { system, left, owner, conflicts, before, after: await sh.cat('/usr/local/bin/dup'), other: (await kernel.commandResolve('other'))?.owner }
  })
  expect(out.system).toBe('EEXIST')
  expect(out.left).toBe(false)
  expect(out.owner).toEqual({ kind: 'bundle', id: 'org.test.first' })
  expect(out.conflicts).toEqual([{ name: 'dup', holder: 'org.test.first', wanted: 'org.test.second' }])
  expect(out.before).toContain('org.test.first')
  expect(out.after).toContain('org.test.second')
})

test('a development link runs the project files in place; moving the project breaks it; it stays inside home', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.installUserland()
    const project = '/Users/pear/Projects/Demo'
    await kernel.mkdir(project, { recursive: true })
    await sh.install(`${project}/manifest.json`, JSON.stringify({ id: 'com.dev.demo', name: 'Demo', version: '0.1.0', kind: 'tool', entry: 'main.js', commands: ['demo'] }))
    await sh.install(`${project}/main.js`, "export default async (tiny) => { await tiny.stdout.write('v1'); return 0 }")
    const link = await kernel.commandLink(project)
    const shim = await sh.cat('/Users/pear/.local/bin/demo')
    const first = await sh.run('/Users/pear/.local/bin/demo')
    await sh.install(`${project}/main.js`, "export default async (tiny) => { await tiny.stdout.write('v2'); return 0 }")
    const second = await sh.run('/Users/pear/.local/bin/demo')
    const outside = await kernel.commandLink('/tmp').then(() => 'linked', (e) => e.code)
    const taken = await (async () => {
      await kernel.mkdir('/Users/pear/Projects/Other', { recursive: true })
      await sh.install('/Users/pear/Projects/Other/manifest.json', JSON.stringify({ id: 'com.dev.other', name: 'Other', version: '1', kind: 'tool', commands: ['ls', 'x'] }))
      await sh.install('/Users/pear/Projects/Other/main.js', 'export default () => 0')
      return kernel.commandLink('/Users/pear/Projects/Other').then(() => 'linked', (e) => e.code)
    })()
    await kernel.rename(project, '/Users/pear/Projects/Moved')
    const broken = await sh.run('/Users/pear/.local/bin/demo').then((st) => ({ code: st.code, stderr: st.stderr, crashed: st.crashed }), (e) => ({ code: e.code, stderr: e.message, crashed: false }))
    const links = await kernel.commandLinks()
    await kernel.commandUnlink(project)
    return { link, shim, first: first.stdout, second: second.stdout, outside, taken, broken, links, gone: await kernel.exists('/Users/pear/.local/bin/demo') }
  })
  expect(out.link).toMatchObject({ path: '/Users/pear/Projects/Demo', bundleId: 'com.dev.demo', commands: ['demo'], broken: false })
  expect(out.shim).toBe('#!pear-command-link /Users/pear/Projects/Demo demo\n')
  expect([out.first, out.second]).toEqual(['v1', 'v2'])
  expect(out.outside).toBe('EPERM')
  expect(out.taken).toBe('EEXIST')
  expect(out.links[0]).toMatchObject({ broken: true })
  expect(JSON.stringify(out.broken)).toContain('linked project not found: /Users/pear/Projects/Demo')
  expect(out.gone).toBe(false)
})

test('a service is supervised: restarts with back-off, gives up after maxRestarts, and obeys stop and disable', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const install = (id: string, service: object, main: string, extra: object = {}) =>
      kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id, name: id.split('.').pop(), version: '1', kind: 'service', entry: 'main.js', service, ...extra }), 'main.js': main } })
    const steady = `export default async (tiny) => { const p = await tiny.portCreate(); await tiny.register('org.test.steady.port', p); console.log('up'); for (;;) await tiny.receive(p) }`
    await install('org.test.steady', { name: 'org.test.steady.port' }, steady)
    await install('org.test.flaky', { name: 'org.test.flaky.port', restart: 'on-failure', restartDelayMs: 20, maxRestarts: 2 }, 'export default async () => 3')
    const pid = await kernel.serviceStart('org.test.steady')
    const running = (await kernel.serviceList()).find((s) => s.id === 'org.test.steady')!
    await kernel.serviceStart('org.test.flaky').catch(() => {})
    for (let i = 0; i < 100; i++) {
      if ((await kernel.serviceList()).find((s) => s.id === 'org.test.flaky')!.state === 'failed') break
      await sh.sleep(50)
    }
    const flaky = (await kernel.serviceList()).find((s) => s.id === 'org.test.flaky')!
    await kernel.serviceDisable('org.test.steady')
    const disabled = (await kernel.serviceList()).find((s) => s.id === 'org.test.steady')!.enabled
    await kernel.serviceStop('org.test.steady')
    const stopped = (await kernel.serviceList()).find((s) => s.id === 'org.test.steady')!
    return { pid, running, flaky, disabled, stopped, logs: await kernel.serviceLogs('org.test.flaky') }
  })
  expect(out.running).toMatchObject({ state: 'running', name: 'org.test.steady.port', pid: out.pid })
  expect(out.flaky.state).toBe('failed')
  expect(out.flaky.lastExit?.code).toBe(3)
  expect(out.flaky.restarts).toBe(2)
  expect(out.flaky.reason).toContain('gave up')
  expect(out.disabled).toBe(false)
  expect(out.stopped).toMatchObject({ state: 'stopped', pid: null })
  expect(out.logs.length).toBeGreaterThan(0)
})

test('which -v, help, man and services speak about registered commands and services', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, tool } = window
    await sh.installUserland()
    await tool('org.test.docs', [{ name: 'docs', summary: 'Shows the docs', man: 'Resources/docs.1', completion: 'Resources/docs.json' }, { name: 'plain', summary: 'No man page' }], {}, {
      'Resources/docs.1': 'DOCS(1) manual\n',
      'Resources/docs.json': JSON.stringify({ flags: ['--all', '--help'], args: [{ kind: 'enum', values: ['alpha', 'beta'] }] }),
    })
    const run = async (path: string, args: string[]) => {
      const st = await sh.run(path, { args, env: { PATH: '/bin:/usr/local/bin' } })
      return { code: st.code, out: st.stdout ?? '', err: st.stderr ?? '' }
    }
    await kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.svc', name: 'svc', version: '1', kind: 'service', service: { name: 'org.test.svc.port' } }), 'main.js': 'export default async (tiny) => { const p = await tiny.portCreate(); await tiny.register("org.test.svc.port", p); for (;;) await tiny.receive(p) }' } })
    return {
      which: await run('/bin/which', ['-v', 'docs']),
      man: await run('/bin/man', ['docs']),
      manGenerated: await run('/bin/man', ['plain']),
      manMissing: await run('/bin/man', ['nothing-here']),
      help: await run('/bin/help', []),
      list: await run('/bin/services', ['list']),
      start: await run('/bin/services', ['start', 'org.test.svc']),
      running: (await run('/bin/services', [])).out,
      stop: await run('/bin/services', ['stop', 'org.test.svc']),
      unknown: await run('/bin/services', ['frobnicate']),
    }
  })
  expect(out.which.out).toContain('/usr/local/bin/docs\tdocs (org.test.docs) - Shows the docs')
  expect(out.man.out).toBe('DOCS(1) manual\n')
  expect(out.manGenerated.out).toContain('plain - No man page')
  expect(out.manMissing).toMatchObject({ code: 1, err: 'No manual entry for nothing-here\n' })
  expect(out.help.out).toContain('docs   Shows the docs')
  expect(out.list.out).toMatch(/org\.test\.svc\s+stopped/)
  expect(out.start.code).toBe(0)
  expect(out.running).toMatch(/org\.test\.svc\s+running/)
  expect(out.stop.code).toBe(0)
  expect(out.unknown.code).toBe(1)
})

test('a command can import files inside its bundle by relative path; escaping the bundle and cycles are refused', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { sh, tool } = window
    await tool('org.test.imp', ['imp'], {}, {
      'main.js': "import { isValidURL } from './utils/url.js'\nexport default async (tiny) => { const [, ...a] = tiny.args; await tiny.stdout.write(a.map((x) => (isValidURL(x) ? 'url' : 'no')).join(',')); return 0 }",
      'utils/url.js': "import { re } from './re.js'\nexport function isValidURL(s) { return re.test(s) }",
      'utils/re.js': 'export const re = /^https?:\\/\\/[a-z.]+$/',
    })
    await tool('org.test.esc', ['esc'], {}, { 'main.js': "import x from '../outside.js'\nexport default async () => 0" })
    await tool('org.test.cyc', ['cyc'], {}, { 'main.js': "import './a.js'\nexport default async () => 0", 'a.js': "import './b.js'", 'b.js': "import './a.js'" })
    const run = (p: string, args: string[] = []) => sh.run(p, { args }).then((st) => ({ code: st.code, out: st.stdout || st.stderr || st.error }), (e) => ({ code: e.code, out: e.message }))
    return { ok: await run('/usr/local/bin/imp', ['https://example.com', 'nope']), esc: await run('/usr/local/bin/esc'), cyc: await run('/usr/local/bin/cyc') }
  })
  expect(out.ok).toEqual({ code: 0, out: 'url,no' })
  expect(out.esc.code).toBe('EACCES')
  expect(out.cyc.code).toBe('ELOOP')
})
