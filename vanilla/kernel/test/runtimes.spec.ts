/**
 * Runtimes: language runtimes are ordinary bundles; the kernel resolves shebangs, command
 * shims, handled extensions and `{runtime}` to the installed runtime's launcher, and checks `requires`.
 */
import { expect, test } from './fixtures'

/** A runtime whose launcher reports how it was started. `extra` goes into `provides`. */
const LAUNCHER = `export default async function (tiny) {
  const env = await tiny.environ()
  const report = { args: tiny.args, rt: env.PEAR_RUNTIME ?? null, ver: env.PEAR_RUNTIME_VERSION ?? null, mode: env.PEAR_RUNTIME_MODE ?? null, dir: env.PEAR_RUNTIME_DIR ?? null, fw: env.PEAR_FRAMEWORKS ?? null, app: env.TINY_APP_ID ?? null }
  if (env.TINY_APP_ID) await tiny.writeFile('/tmp/launch.out', new TextEncoder().encode(JSON.stringify(report)))
  else tiny.stdout.write(JSON.stringify(report))
  return 0
}`

declare global {
  interface Window {
    /** Install a runtime bundle: `lang` by default. */
    rt(id: string, provides: Record<string, unknown>, extra?: Record<string, unknown>, files?: Record<string, string>): Promise<import('../src/bundle').BundleInfo>
  }
}

test.beforeEach(async ({ page }) => {
  await page.evaluate((launcher) => {
    window.rt = (id, provides, extra = {}, files = {}) =>
      window.kernel.bundleInstall({
        files: {
          'manifest.json': JSON.stringify({ id, name: id.split('.').pop(), version: '1.0.0', kind: 'runtime', entry: 'launcher.js', provides, ...extra }),
          'launcher.js': launcher,
          ...files,
        },
      })
  }, LAUNCHER)
})

test('a runtime is validated, listed, resolvable, and owns its command shim', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    const bad = (provides: unknown, extra: object = {}) =>
      kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.bad', name: 'bad', version: '1.0.0', kind: 'runtime', entry: 'launcher.js', provides, ...extra }), 'launcher.js': 'export default () => 0' } }).then(() => 'installed', (e) => `${e.code}: ${e.message}`)
    const refused = {
      noProvides: await bad(undefined),
      badName: await bad({ name: 'Node!', version: '1.0.0' }),
      badVersion: await bad({ name: 'lang', version: 'x' }),
      badCommand: await bad({ name: 'lang', version: '1.0.0', commands: ['a/b'] }),
      missingEmbed: await bad({ name: 'lang', version: '1.0.0', abi: ['embed'], embed: 'nope.js' }),
      badRange: await kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.app', name: 'app', version: '1.0.0', requires: [{ runtime: 'lang', range: '>>' }] }), 'main.js': 'export default () => 0' } }).then(() => 'installed', (e) => e.code),
      bothKinds: await kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.app', name: 'app', version: '1.0.0', requires: [{ runtime: 'a', framework: 'b' }] }), 'main.js': 'export default () => 0' } }).then(() => 'installed', (e) => e.code),
    }
    const before = await kernel.runtimeList()
    const info = await rt('org.test.lang', { name: 'lang', version: '1.2.0', abi: ['program', 'embed'], commands: ['lang'], shebangs: ['lang'], handles: [{ ext: ['LNG'] }], embed: 'embed.js' }, {}, { 'embed.js': '// embed' })
    const list = await kernel.runtimeList()
    const shim = await sh.cat('/usr/local/bin/lang')
    const mode = (await kernel.stat('/usr/local/bin/lang')).mode & 0o777
    return {
      refused,
      before,
      info: { kind: info.kind, entry: info.entry, path: info.path },
      list,
      byName: await kernel.runtimeResolve({ name: 'lang' }),
      byRange: await kernel.runtimeInfo('lang', '^2'),
      byCommand: (await kernel.runtimeResolve({ command: 'lang' }))?.bundleId,
      byShebang: (await kernel.runtimeResolve({ shebang: 'lang' }))?.bundleId,
      byPath: (await kernel.runtimeResolve({ path: '/tmp/a.lng' }))?.bundleId,
      byOtherPath: await kernel.runtimeResolve({ path: '/tmp/a.txt' }),
      shim,
      mode,
      apps: (await kernel.launchApps()).map((a) => a.id),
      launch: await kernel.launchOpen('org.test.lang').then(() => 'ok', (e) => e.code),
    }
  })
  for (const key of Object.keys(out.refused)) expect(out.refused[key as keyof typeof out.refused], key).toMatch(/^(EINVAL)/)
  expect(out.before).toEqual([])
  expect(out.info.kind).toBe('runtime')
  expect(out.info.path).toBe('/Applications/lang.app')
  expect(out.list).toHaveLength(1)
  expect(out.list[0]).toMatchObject({ name: 'lang', version: '1.2.0', bundleId: 'org.test.lang', commands: ['lang'], default: true, abi: ['program', 'embed'], embed: '/Applications/lang.app/embed.js' })
  expect(out.byName?.bundleId).toBe('org.test.lang')
  expect(out.byRange).toBeNull()
  expect([out.byCommand, out.byShebang, out.byPath]).toEqual(['org.test.lang', 'org.test.lang', 'org.test.lang'])
  expect(out.byOtherPath).toBeNull()
  expect(out.shim).toBe('#!pear-runtime-command lang\n')
  expect(out.mode).toBe(0o755)
  // a runtime is not an app: not listed with the apps, and not something to open
  expect(out.apps).not.toContain('org.test.lang')
  expect(out.launch).toBe('EINVAL')
})

test('the command shim, a #! line, a handled extension and {runtime} all start the launcher', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    await sh.installUserland()
    await rt('org.test.lang', { name: 'lang', version: '1.2.0', commands: ['lang'], shebangs: ['lang'], handles: [{ ext: ['lng', 'js'] }] })
    const run = async (path: string, opts?: object) => {
      const st = await sh.run(path, opts)
      return { code: st.code, out: st.stdout ?? '', err: st.stderr ?? '' }
    }
    await sh.install('/tmp/a.lng', 'print "hi"\n')
    await sh.install('/tmp/sheb', '#!/usr/bin/env lang\nprint "hi"\n')
    await sh.install('/tmp/sheb2', '#!/usr/local/bin/lang -x\nprint\n')
    await sh.install('/tmp/echoed', '#!/bin/echo\nbody\n')
    await sh.install('/tmp/php', '#!/usr/bin/env php\n<?php ?>\n')
    // a Pear program in a file the runtime also handles stays a Pear program
    await sh.install('/tmp/pear.js', 'export default async function (tiny) { tiny.stdout.write("pear program") }')
    await sh.install('/tmp/script.js', 'console.log("from a script")\n')
    return {
      command: await run('/usr/local/bin/lang', { args: ['-e', 'x y'] }),
      shebang: await run('/tmp/sheb', { args: ['one'] }),
      shebangFlags: await run('/tmp/sheb2'),
      binInterpreter: await run('/tmp/echoed', { args: ['z'] }),
      noRuntime: await sh.run('/tmp/php').then((s) => `status ${s.code}`, (e) => `${e.code}: ${e.message}`),
      extension: await run('/tmp/a.lng', { args: ['p'] }),
      named: await run('/tmp/script.js', { runtime: 'lang', args: ['q'] }),
      pearJs: await run('/tmp/pear.js'),
      scriptJs: await run('/tmp/script.js'),
      unknownNamed: await sh.run('/tmp/a.lng', { runtime: 'ruby' }).then(() => 'ran', (e) => `${e.code}: ${e.message}`),
      pearFlag: await run('/tmp/pear.js', { runtime: 'pear' }),
    }
  })
  const rep = (r: { out: string }) => JSON.parse(r.out)
  expect(rep(out.command)).toMatchObject({ args: ['-e', 'x y'], rt: 'lang', ver: '1.2.0', mode: 'command', dir: '/Applications/lang.app/' })
  expect(rep(out.shebang)).toMatchObject({ args: ['/tmp/sheb', 'one'], rt: 'lang', mode: 'script' })
  expect(rep(out.shebangFlags)).toMatchObject({ args: ['/tmp/sheb2'], rt: 'lang' })
  expect(out.binInterpreter.out).toBe('/tmp/echoed z\n')
  expect(out.noRuntime).toMatch(/^ENOENT: no runtime provides "php"/)
  expect(rep(out.extension)).toMatchObject({ args: ['/tmp/a.lng', 'p'], rt: 'lang', mode: 'script' })
  expect(rep(out.named)).toMatchObject({ args: ['/tmp/script.js', 'q'], rt: 'lang' })
  expect(out.pearJs.out).toBe('pear program')
  expect(out.pearFlag.out).toBe('pear program')
  expect(rep(out.scriptJs)).toMatchObject({ args: ['/tmp/script.js'], rt: 'lang' })
  expect(out.unknownNamed).toMatch(/^ENOENT: no runtime provides "ruby"/)
})

test('versions install side by side; the highest wins until the user picks another', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    await rt('org.test.lang1', { name: 'lang', version: '1.4.0', commands: ['lang'] })
    await rt('org.test.lang2', { name: 'lang', version: '2.1.0', commands: ['lang'] })
    const ask = async () => JSON.parse((await sh.run('/usr/local/bin/lang')).stdout ?? '{}').ver
    const high = await ask()
    const r1 = (await kernel.runtimeInfo('lang', '^1'))?.bundleId
    const r2 = (await kernel.runtimeInfo('lang', '>=2 <3'))?.bundleId
    const none = await kernel.runtimeInfo('lang', '^3')
    await kernel.runtimeSetDefault('lang', 'org.test.lang1')
    const picked = await ask()
    const defaults = (await kernel.runtimeList()).map((r) => `${r.bundleId}:${r.default}`).sort()
    const bad = await kernel.runtimeSetDefault('lang', 'org.nope').then(() => 'ok', (e) => e.code)
    // the choice survives removing the other one, and disappears with the chosen one
    await kernel.bundleUninstall('org.test.lang2')
    const afterOther = await ask()
    await kernel.bundleUninstall('org.test.lang1')
    const shimGone = await kernel.exists('/usr/local/bin/lang')
    const state = JSON.parse(await sh.cat('/var/db/runtimes.json'))
    return { high, r1, r2, none, picked, defaults, bad, afterOther, shimGone, state }
  })
  expect(out.high).toBe('2.1.0')
  expect(out.r1).toBe('org.test.lang1')
  expect(out.r2).toBe('org.test.lang2')
  expect(out.none).toBeNull()
  expect(out.picked).toBe('1.4.0')
  expect(out.defaults).toEqual(['org.test.lang1:true', 'org.test.lang2:false'])
  expect(out.bad).toBe('ENOENT')
  expect(out.afterOther).toBe('1.4.0')
  expect(out.shimGone).toBe(false)
  expect(out.state).toEqual({ defaults: {}, commands: {} })
})

test('a command is kept by the first runtime; a system program cannot be shadowed', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    await sh.installUserland()
    await rt('org.test.first', { name: 'first', version: '1.0.0', commands: ['tool'] })
    await rt('org.test.second', { name: 'second', version: '1.0.0', commands: ['tool', 'other'] })
    const owner = JSON.parse((await sh.run('/usr/local/bin/tool')).stdout ?? '{}').rt
    const other = JSON.parse((await sh.run('/usr/local/bin/other')).stdout ?? '{}').rt
    const conflicts = await kernel.runtimeConflicts()
    const system = await rt('org.test.ls', { name: 'ls', version: '1.0.0', commands: ['ls'] }).then(() => 'installed', (e) => `${e.code}: ${e.message}`)
    const leftovers = (await kernel.readdir('/Applications')).map((e) => e.name).sort()
    const lsShim = (await sh.cat('/bin/ls')).startsWith('#!pear')
    // removing the holder hands the command over on the next sync
    await kernel.bundleUninstall('org.test.first')
    const afterHolder = JSON.parse((await sh.run('/usr/local/bin/tool')).stdout ?? '{}').rt
    return { owner, other, conflicts, system, leftovers, lsShim, afterHolder }
  })
  expect(out.owner).toBe('first')
  expect(out.other).toBe('second')
  expect(out.conflicts).toEqual([{ command: 'tool', holder: 'first', wanted: 'second' }])
  expect(out.system).toMatch(/^EEXIST: .*"ls".*system program/)
  expect(out.leftovers).toEqual(['first.app', 'second.app'])
  expect(out.lsShim).toBe(false)
  expect(out.afterHolder).toBe('second')
})

test('requires: an app that needs a runtime or framework does not start without it, and says why', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    const need = [{ runtime: 'lang', range: '^2' }, { framework: 'wasi', range: '^1' }]
    const app = await sh.app('org.test.needy', 'print "script"', { runtime: 'lang', requires: need, singleInstance: false })
    const unmet0 = await kernel.runtimeUnmet(need)
    const start0 = await kernel.launchOpen('org.test.needy').then(() => 'started', (e) => `${e.code}: ${e.message}`)

    await rt('org.test.lang1', { name: 'lang', version: '1.0.0' })
    const unmet1 = await kernel.runtimeUnmet(need)
    await rt('org.test.lang2', { name: 'lang', version: '2.0.0' })
    const unmet2 = await kernel.runtimeUnmet(need)
    const start2 = await kernel.launchOpen('org.test.needy').then(() => 'started', (e) => `${e.code}: ${e.message}`)

    await kernel.bundleInstall({
      files: {
        'manifest.json': JSON.stringify({ id: 'org.test.wasi', name: 'WASI', version: '1.0.0', kind: 'framework', provides: { framework: 'wasi', version: '1.3.0', api: 'wasi_snapshot_preview1', module: 'wasi.js' } }),
        'wasi.js': '// shim',
      },
    })
    const unmet3 = await kernel.runtimeUnmet(need)
    const pid = await kernel.launchOpen('org.test.needy')
    await kernel.wait(pid)
    const ran = JSON.parse(await sh.cat('/tmp/launch.out'))
    return { app: app.runtime, unmet0, start0, unmet1, unmet2, start2, unmet3, ran, frameworks: await kernel.frameworkList(), resolved: await kernel.frameworkResolve('wasi', { range: '^1' }), none: await kernel.frameworkResolve('wasi', { range: '^2' }) }
  })
  expect(out.app).toBe('lang')
  expect(out.unmet0.map((u) => `${u.kind}:${u.name}:${u.reason}`)).toEqual(['runtime:lang:not installed', 'framework:wasi:not installed'])
  expect(out.start0).toMatch(/^ENOENT: needy needs runtime lang \^2 \(not installed\), framework wasi \^1/)
  expect(out.unmet1[0]!.reason).toContain('installed 1.0.0 does not satisfy ^2')
  expect(out.unmet2.map((u) => u.name)).toEqual(['wasi'])
  expect(out.start2).toMatch(/^ENOENT: needy needs framework wasi/)
  expect(out.unmet3).toEqual([])
  // the app's bundle `runtime` ran its entry through the launcher, and its own requires reached the environment
  expect(out.ran).toMatchObject({ rt: 'lang', ver: '2.0.0', app: 'org.test.needy' })
  expect(out.ran.args[0]).toBe('/Applications/needy.app/main.js')
  expect(out.frameworks).toHaveLength(1)
  expect(out.frameworks[0]).toMatchObject({ name: 'wasi', version: '1.3.0', api: 'wasi_snapshot_preview1', bundleId: 'org.test.wasi', path: '/Library/Frameworks/WASI.framework', module: '/Library/Frameworks/WASI.framework/wasi.js' })
  expect(out.resolved?.version).toBe('1.3.0')
  expect(out.none).toBeNull()
})

test('a runtime that requires a framework gets it in PEAR_FRAMEWORKS, and does not start without it', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    await rt('org.test.wasmlang', { name: 'wasmlang', version: '1.0.0', commands: ['wl'] }, { requires: [{ framework: 'wasi', range: '^1' }] })
    const without = await sh.run('/usr/local/bin/wl').then(() => 'ran', (e) => `${e.code}: ${e.message}`)
    await kernel.bundleInstall({
      files: {
        'manifest.json': JSON.stringify({ id: 'org.test.wasi', name: 'WASI', version: '1.0.0', kind: 'framework', provides: { framework: 'wasi', version: '1.0.0', module: 'wasi.js' } }),
        'wasi.js': '// shim',
      },
    })
    const withIt = JSON.parse((await sh.run('/usr/local/bin/wl')).stdout ?? '{}')
    const missing = await kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.fw2', name: 'fw2', version: '1.0.0', kind: 'framework', provides: { framework: 'x', version: '1.0.0', module: 'gone.js' } }) } }).then(() => 'installed', (e) => e.code)
    const wrongLocation = await kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'org.test.fw3', name: 'fw3', version: '1.0.0', kind: 'framework', provides: { framework: 'x', version: '1.0.0', module: 'm.js' } }), 'm.js': '' } }, { location: '/Applications' }).then(() => 'installed', (e) => e.code)
    // uninstalling the framework makes the runtime unusable again
    await kernel.bundleUninstall('org.test.wasi')
    const after = await sh.run('/usr/local/bin/wl').then(() => 'ran', (e) => `${e.code}: ${e.message}`)
    return { without, withIt, missing, wrongLocation, after }
  })
  expect(out.without).toMatch(/^ENOENT: wasmlang needs framework wasi \^1 \(not installed\)/)
  expect(JSON.parse(out.withIt.fw)).toEqual({ wasi: { version: '1.0.0', path: '/Library/Frameworks/WASI.framework', module: '/Library/Frameworks/WASI.framework/wasi.js' } })
  expect(out.missing).toBe('EINVAL')
  expect(out.wrongLocation).toBe('EINVAL')
  expect(out.after).toMatch(/^ENOENT: wasmlang needs framework wasi/)
})

test('embed: a runtime with the embed abi hands its script path to an embedding app', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, rt } = window
    await rt('org.test.embeddable', { name: 'emb', version: '3.0.0', abi: ['program', 'embed'], embed: 'embed.js' }, {}, { 'embed.js': '// embed' })
    await rt('org.test.plain', { name: 'plain', version: '1.0.0' })
    return {
      ok: await kernel.runtimeEmbed('emb'),
      range: await kernel.runtimeEmbed('emb', { range: '^3' }).then(() => 'ok', (e) => e.code),
      outOfRange: await kernel.runtimeEmbed('emb', { range: '^4' }).then(() => 'ok', (e) => e.code),
      plain: await kernel.runtimeEmbed('plain').then(() => 'ok', (e) => e.code),
      missing: await kernel.runtimeEmbed('nothing').then(() => 'ok', (e) => e.code),
    }
  })
  expect(out.ok).toEqual({ name: 'emb', version: '3.0.0', bundleId: 'org.test.embeddable', abi: ['program', 'embed'], scriptPath: '/Applications/embeddable.app/embed.js' })
  expect(out.range).toBe('ok')
  expect(out.outOfRange).toBe('ENOENT')
  expect(out.plain).toBe('ENOSYS')
  expect(out.missing).toBe('ENOENT')
})

test('a rescan rebuilds the registry from the bundles, keeps the chosen default, and cleans up stale shims', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh, rt } = window
    await rt('org.test.lang1', { name: 'lang', version: '1.0.0', commands: ['lang'] })
    await rt('org.test.lang2', { name: 'lang', version: '2.0.0', commands: ['lang'] })
    await kernel.runtimeSetDefault('lang', 'org.test.lang1')
    // a stale shim for a runtime that no longer exists is cleaned up by a rescan
    await sh.install('/usr/local/bin/ghost', '#!pear-runtime-command ghost\n')
    await sh.install('/usr/local/bin/mine', 'not a shim')
    await kernel.bundleRescan()
    return {
      defaults: (await kernel.runtimeList()).map((r) => `${r.bundleId}:${r.default}`).sort(),
      ghost: await kernel.exists('/usr/local/bin/ghost'),
      mine: await kernel.exists('/usr/local/bin/mine'),
    }
  })
  expect(out.defaults).toEqual(['org.test.lang1:true', 'org.test.lang2:false'])
  expect(out.ghost).toBe(false)
  expect(out.mine).toBe(true)
})
