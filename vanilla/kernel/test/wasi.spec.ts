/**
 * The WASI framework (`frameworks/wasi`): a real Rust program built for wasm32-wasip1 runs through a
 * tiny runtime whose launcher loads the system framework. The probe (`test/wasi/probe.rs`) exercises arguments, the
 * environment, standard streams, files, time, randomness and exit codes from the inside.
 */
import { readFile } from 'node:fs/promises'

import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })


/** A runtime that runs `.wasm` programs: load the WASI framework from PEAR_FRAMEWORKS, instantiate, start. */
const LAUNCHER = `export default async function (tiny) {
  const env = await tiny.environ()
  const fw = JSON.parse(env.PEAR_FRAMEWORKS).wasi
  const source = await tiny.readFile(fw.module)
  const { createWasi, hostFromTiny } = await import(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })))
  const [program, ...rest] = tiny.args
  const wasi = createWasi({ host: hostFromTiny(tiny), args: [program, ...rest], env: { PROBE: env.PROBE ?? '' }, preopens: { '/': await tiny.getcwd() } })
  const { instance } = await WebAssembly.instantiate(await tiny.readFile(program), wasi.imports)
  return wasi.start(instance)
}`

test.beforeEach(async ({ page }) => {
  const PROBE = Array.from(await readFile(new URL('./wasi/probe.wasm', import.meta.url).pathname) as unknown as ArrayLike<number>)
  await page.evaluate(async ([launcher, probe]) => {
    const { kernel, sh } = window
    await kernel.bundleInstall({
      files: {
        'manifest.json': JSON.stringify({ id: 'org.test.wasm', name: 'wasm', version: '1.0.0', kind: 'runtime', entry: 'launcher.js', provides: { name: 'wasm', version: '1.0.0', commands: ['wasm'], handles: [{ ext: ['wasm'] }] }, requires: [{ framework: 'wasi', range: '^1' }] }),
        'launcher.js': launcher as string,
      },
    })
    await kernel.mkdir('/tmp/box', { recursive: true })
    await kernel.writeFile('/tmp/box/probe.wasm', new Uint8Array(probe as number[]))
    await sh.install('/tmp/box/note.txt', 'hello there\n')
  }, [LAUNCHER, PROBE] as const)
})

interface Run {
  code: number | null
  out: string
  err: string
  crashed: boolean
}

/** Run the probe with a subcommand. The program's folder is `/tmp/box`, which it sees as `/`. */
const probe = (page: import('@playwright/test').Page, args: string[], opts: Record<string, unknown> = {}): Promise<Run> =>
  page.evaluate(async ([args, opts]) => {
    const st = await window.sh.run('/usr/local/bin/wasm', { cwd: '/tmp/box', args: ['/tmp/box/probe.wasm', ...(args as string[])], env: { PROBE: 'yes' }, ...(opts as object) })
    return { code: st.code, out: st.stdout ?? '', err: st.stderr ?? '', crashed: st.crashed }
  }, [args, opts] as const)

test('the framework is a system bundle installed at boot, pinned by version', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    return { list: await kernel.frameworkList(), ok: await kernel.frameworkResolve('wasi', { range: '^1' }), none: await kernel.frameworkResolve('wasi', { range: '^2' }), info: await kernel.bundleInfo('org.tiny.framework.wasi') }
  })
  expect(out.list).toHaveLength(1)
  expect(out.ok).toMatchObject({ name: 'wasi', version: '1.0.0', api: 'wasi_snapshot_preview1', bundleId: 'org.tiny.framework.wasi', path: '/System/Library/Frameworks/WASI.framework', module: '/System/Library/Frameworks/WASI.framework/wasi.js' })
  expect(out.none).toBeNull()
  expect(out.info).toMatchObject({ kind: 'framework', system: true })
})

test('arguments, environment, stdout, stderr and the exit code reach a real wasm program', async ({ page }) => {
  const r = await probe(page, ['hello', '3', 'two words'])
  expect(r.out).toBe('hello from wasi\nargs=3,two words\nenv=yes\n')
  expect(r.err).toBe('to stderr\n')
  expect(r.code).toBe(3)
})

test('standard input is read to the end', async ({ page }) => {
  const r = await probe(page, ['stdin'], { stdio: { stdin: { file: '/tmp/box/note.txt' } } })
  expect(r.out).toBe('12 bytes: HELLO THERE\n')
  expect(r.code).toBe(0)
})

test('files: create, append, seek, read, list, rename, remove, errors, and a large file', async ({ page }) => {
  const r = await probe(page, ['fs'])
  expect(r.err).toBe('')
  expect(r.out.trim().split('\n')).toEqual([
    'read=hello world',
    'seek=hello WORLD',
    'tell=11',
    'len=11 file=true dir=true',
    'list=a.txt,b.txt,deep',
    'renamed=true',
    'missing=NotFound',
    'exists=AlreadyExists',
    'notempty=Some(55)',
    'big=300000',
    'gone=true',
  ])
  expect(r.code).toBe(0)
  // the program changed only its own folder, and removed everything it made
  expect(await page.evaluate(() => window.kernel.readdir('/tmp/box').then((l) => l.map((e) => e.name).sort()))).toEqual(['note.txt', 'probe.wasm'])
})

test('time and randomness work, and a trapping program is a crash, not a hang', async ({ page }) => {
  expect((await probe(page, ['time'])).out).toBe('slept>=60:true wall>2020:true\n')
  expect((await probe(page, ['rand'])).out).toBe('random ok 2\n')
  const trap = await probe(page, ['panic'])
  expect(trap.code).not.toBe(0)
  expect(trap.err).toContain('boom')
})

test('a program cannot leave its preopened folder', async ({ page }) => {
  await page.evaluate(() => window.sh.install('/tmp/outside.txt', 'secret'))
  const r = await probe(page, ['escape'])
  expect(r.out).not.toContain('opened')
  expect(r.out.trim().split('\n')).toHaveLength(3)
})

test('a .wasm file runs through its runtime by extension', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const st = await window.sh.run('/tmp/box/probe.wasm', { cwd: '/tmp/box', args: ['hello'], env: { PROBE: 'ext' } })
    return st.stdout
  })
  expect(out).toBe('hello from wasi\nargs=\nenv=ext\n')
})

test('the system framework cannot be removed', async ({ page }) => {
  const code = await page.evaluate(() => window.kernel.bundleUninstall('org.tiny.framework.wasi').then(() => 'removed', (e) => e.code))
  expect(code).toBe('EPERM')
})
