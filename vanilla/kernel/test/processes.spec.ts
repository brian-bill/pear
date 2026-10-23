/**
 * Process model tests: real Workers talking to the kernel over MessagePorts,
 * with the file system on real OPFS.
 */
import { expect, test } from './fixtures'

test('runs a program that uses the file system and writes to stdout', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/hello.js',
      `export default async (tiny) => {
         await tiny.writeFile('/tmp/hello.txt', new TextEncoder().encode('hi from ' + tiny.pid))
         console.log('wrote', 'it')
         console.error('a warning')
       }`,
    )
    const pid = await kernel.spawn('/Applications/hello.js')
    const status = await kernel.wait(pid)
    return { pid, status, file: await sh.cat('/tmp/hello.txt') }
  })
  expect(out.status).toMatchObject({ pid: out.pid, code: 0, signal: null, crashed: false })
  expect(out.status.stdout).toBe('wrote it\n')
  expect(out.status.stderr).toBe('a warning\n')
  expect(out.file).toBe(`hi from ${out.pid}`)
})

test('exit codes come from exit() or the return value', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { sh } = window
    await sh.install('/Applications/a.js', `export default async (t) => { await t.exit(3); throw new Error('unreachable') }`)
    await sh.install('/Applications/b.js', `export default () => 7`)
    await sh.install('/Applications/c.js', `export default async () => {}`)
    return [(await sh.run('/Applications/a.js')).code, (await sh.run('/Applications/b.js')).code, (await sh.run('/Applications/c.js')).code]
  })
  expect(codes).toEqual([3, 7, 0])
})

test('programs receive args, env, cwd, and pids; relative paths use the cwd', async ({ page }) => {
  const info = await page.evaluate(async () => {
    const { sh } = window
    await sh.install(
      '/Applications/info.js',
      `export default async (t) => {
         await t.mkdir('out')
         await t.writeFile('out/info.json', new TextEncoder().encode(JSON.stringify({
           args: t.args, foo: await t.getenv('FOO'), missing: await t.getenv('NOPE'),
           cwd: await t.getcwd(), ppid: await t.getppid(), name: t.name,
         })))
       }`,
    )
    await sh.run('/Applications/info.js', { args: ['a', 'b'], env: { FOO: 'bar' }, cwd: '/tmp' })
    return JSON.parse(await sh.cat('/tmp/out/info.json'))
  })
  expect(info).toEqual({ args: ['a', 'b'], foo: 'bar', missing: null, cwd: '/tmp', ppid: 1, name: 'info.js' })
})

test('chdir changes how relative paths resolve, and rejects non-directories', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { sh } = window
    await sh.install(
      '/Applications/cd.js',
      `export default async (t) => {
         const r = {}
         r.first = await t.chdir('/Users')
         await t.mkdir('proj')
         r.up = await t.chdir('proj/..')
         r.rel = await t.chdir('proj')
         await t.writeFile('note', new TextEncoder().encode('x'))
         await t.writeFile('/tmp/file', new Uint8Array())
         try { await t.chdir('/tmp/file') } catch (e) { r.file = e.code }
         try { await t.chdir('/nowhere') } catch (e) { r.missing = e.code }
         r.exists = await t.exists('/Users/proj/note')
         await t.writeFile('/tmp/cd.json', new TextEncoder().encode(JSON.stringify(r)))
       }`,
    )
    await sh.run('/Applications/cd.js')
    return JSON.parse(await sh.cat('/tmp/cd.json'))
  })
  expect(out).toEqual({ first: '/Users', up: '/Users', rel: '/Users/proj', file: 'ENOTDIR', missing: 'ENOENT', exists: true })
})

test('file system errors reach the program with errno codes', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { sh } = window
    await sh.install(
      '/Applications/err.js',
      `export default async (t) => {
         const code = (p) => p.then(() => 'ok', (e) => e.code)
         await t.mkdir('/tmp/d')
         const r = [await code(t.stat('/tmp/none')), await code(t.mkdir('/tmp/d')), await code(t.readFile('/tmp')), await code(t.rmdir('/tmp/none'))]
         await t.writeFile('/tmp/err.json', new TextEncoder().encode(JSON.stringify(r)))
       }`,
    )
    await sh.run('/Applications/err.js')
    return JSON.parse(await sh.cat('/tmp/err.json'))
  })
  expect(codes).toEqual(['ENOENT', 'EEXIST', 'EISDIR', 'ENOENT'])
})

// ---------------------------------------------------------------- crashes

test('an uncaught exception is a crash with exit code 1 and the message on stderr', async ({ page }) => {
  const status = await page.evaluate(async () => {
    await window.sh.install('/Applications/boom.js', `export default async () => { throw new Error('boom') }`)
    return window.sh.run('/Applications/boom.js')
  })
  expect(status).toMatchObject({ code: 1, crashed: true, error: 'boom' })
  expect(status.stderr).toContain('boom')
})

test('an unhandled rejection after main returns still crashes the process', async ({ page }) => {
  const status = await page.evaluate(async () => {
    await window.sh.install(
      '/Applications/late.js',
      `export default async () => { setTimeout(() => Promise.reject(new Error('late failure')), 20); await new Promise(() => {}) }`,
    )
    return window.sh.run('/Applications/late.js')
  })
  expect(status).toMatchObject({ crashed: true, error: 'late failure' })
})

test('a program with a syntax error or no entry point crashes cleanly', async ({ page }) => {
  const [syntax, noMain] = await page.evaluate(async () => {
    const { sh } = window
    await sh.install('/Applications/bad.js', `export default (`)
    await sh.install('/Applications/nomain.js', `export const x = 1`)
    return [await sh.run('/Applications/bad.js'), await sh.run('/Applications/nomain.js')]
  })
  expect(syntax.crashed).toBe(true)
  expect(noMain).toMatchObject({ crashed: true, error: 'program must export a default function' })
})

// ---------------------------------------------------------------- signals

test('SIGTERM ends a program that has no handler', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install('/Applications/idle.js', `export default () => new Promise(() => {})`)
    const pid = await kernel.spawn('/Applications/idle.js')
    const before = (await kernel.processInfo(pid)).state
    await kernel.kill(pid, 'SIGTERM')
    return { before, status: await kernel.wait(pid) }
  })
  expect(out.before).toBe('running')
  expect(out.status).toMatchObject({ code: null, signal: 'SIGTERM', crashed: false })
})

test('a SIGTERM handler can shut down gracefully', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/graceful.js',
      `export default async (t) => {
         t.onSignal('SIGTERM', async () => {
           await t.writeFile('/tmp/graceful', new TextEncoder().encode('saved'))
           await t.exit(0)
         })
         await t.writeFile('/tmp/ready', new Uint8Array())
         await new Promise(() => {})
       }`,
    )
    const pid = await kernel.spawn('/Applications/graceful.js')
    await sh.waitFor('/tmp/ready')
    await kernel.kill(pid, 'SIGTERM')
    return { status: await kernel.wait(pid), saved: await sh.cat('/tmp/graceful') }
  })
  expect(out.status).toMatchObject({ code: 0, signal: null })
  expect(out.saved).toBe('saved')
})

test('a handled signal does not end the program', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/usr1.js',
      `export default async (t) => {
         let n = 0
         t.onSignal('SIGUSR1', async () => { n++; await t.writeFile('/tmp/usr1-' + n, new Uint8Array()) })
         await t.writeFile('/tmp/ready', new Uint8Array())
         await new Promise(() => {})
       }`,
    )
    const pid = await kernel.spawn('/Applications/usr1.js')
    await sh.waitFor('/tmp/ready')
    await kernel.kill(pid, 'SIGUSR1')
    await sh.waitFor('/tmp/usr1-1')
    await kernel.kill(pid, 'SIGUSR1')
    await sh.waitFor('/tmp/usr1-2')
    const stillRunning = (await kernel.processInfo(pid)).state === 'running'
    await kernel.kill(pid, 'SIGKILL')
    return { stillRunning, status: await kernel.wait(pid) }
  })
  expect(out.stillRunning).toBe(true)
  expect(out.status.signal).toBe('SIGKILL')
})

test('SIGKILL stops a program stuck in an infinite loop, and the kernel stays responsive', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/spin.js',
      `export default async (t) => { await t.writeFile('/tmp/ready', new Uint8Array()); while (true) {} }`,
    )
    const pid = await kernel.spawn('/Applications/spin.js')
    await sh.waitFor('/tmp/ready')
    await kernel.kill(pid, 'SIGTERM') // never delivered: the loop never yields
    await sh.sleep(100)
    const stuck = (await kernel.processInfo(pid)).state
    await kernel.kill(pid, 'SIGKILL')
    const status = await kernel.wait(pid)
    return { stuck, status, responsive: (await kernel.readdir('/tmp')).length > 0 }
  })
  expect(out.stuck).toBe('running')
  expect(out.status.signal).toBe('SIGKILL')
  expect(out.responsive).toBe(true)
})

test('kill validates its arguments', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { kernel, sh } = window
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
    await sh.install('/Applications/idle.js', `export default () => new Promise(() => {})`)
    const pid = await kernel.spawn('/Applications/idle.js')
    const r = {
      missing: await code(kernel.kill(9999)),
      init: await code(kernel.kill(1)),
      stop: await code(kernel.kill(pid, 'SIGSTOP' as never)),
      bogus: await code(kernel.kill(pid, 'SIGWAT' as never)),
    }
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)
    return { ...r, afterExit: await code(kernel.kill(pid)) }
  })
  expect(codes).toEqual({ missing: 'ESRCH', init: 'EPERM', stop: 'ENOSYS', bogus: 'EINVAL', afterExit: 'ESRCH' })
})

// ------------------------------------------------------- file descriptors

test('files a process leaves open are closed when it exits', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    const dataFiles = async () => {
      const root = await navigator.storage.getDirectory()
      const data = await (await root.getDirectoryHandle(ns)).getDirectoryHandle('data')
      let n = 0
      for await (const _ of data.keys()) n++
      return n
    }
    await sh.install(
      '/Applications/leak.js',
      `export default async (t) => {
         const fd = await t.open('/tmp/leak', 2 | 0x40)
         await t.write(fd, new TextEncoder().encode('data'))
         await t.writeFile('/tmp/ready', new Uint8Array())
         await new Promise(() => {})
       }`,
    )
    await kernel.flush()
    const baseline = await dataFiles() // after installing: only the process's own files are counted

    const pid = await kernel.spawn('/Applications/leak.js')
    await sh.waitFor('/tmp/ready')
    const open = (await kernel.processInfo(pid)).openFds
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)

    // If the fd had leaked, unlinking would leave the blob behind.
    await kernel.unlink('/tmp/leak')
    await kernel.unlink('/tmp/ready')
    await kernel.flush()
    return { open, leaked: (await dataFiles()) - baseline }
  }, ns)
  expect(out.open).toBe(1)
  expect(out.leaked).toBe(0)
})

test("a process cannot use another process's file descriptor", async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/owner.js',
      `export default async (t) => {
         const fd = await t.open('/tmp/secret', 2 | 0x40)
         await t.write(fd, new TextEncoder().encode('hunter2'))
         await t.writeFile('/tmp/fd', new TextEncoder().encode(String(fd)))
         await new Promise(() => {})
       }`,
    )
    await sh.install(
      '/Applications/thief.js',
      `export default async (t) => {
         const fd = Number(t.args[0])
         const code = (p) => p.then(() => 'ok', (e) => e.code)
         const r = [await code(t.read(fd, 7, 0)), await code(t.write(fd, new Uint8Array([1]))), await code(t.close(fd)), await code(t.fstat(fd))]
         await t.writeFile('/tmp/thief.json', new TextEncoder().encode(JSON.stringify(r)))
       }`,
    )
    const owner = await kernel.spawn('/Applications/owner.js')
    await sh.waitFor('/tmp/fd')
    await sh.run('/Applications/thief.js', { args: [await sh.cat('/tmp/fd')] })
    const attempts = JSON.parse(await sh.cat('/tmp/thief.json'))
    const intact = await sh.cat('/tmp/secret')
    await kernel.kill(owner, 'SIGKILL')
    await kernel.wait(owner)
    return { attempts, intact }
  })
  expect(result.attempts).toEqual(['EBADF', 'EBADF', 'EBADF', 'EBADF'])
  expect(result.intact).toBe('hunter2')
})

// ---------------------------------------------------- parents and children

test('a process can spawn a child, wait for it, and read its output', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { sh } = window
    await sh.install(
      '/Applications/child.js',
      `export default async (t) => { console.log('child of', await t.getppid()); await t.exit(Number(t.args[0])) }`,
    )
    await sh.install(
      '/Applications/parent.js',
      `export default async (t) => {
         const pid = await t.spawn('/Applications/child.js', { args: ['5'] })
         const st = await t.wait(pid)
         const gone = await t.info(pid).then(() => 'still there', (e) => e.code)
         await t.writeFile('/tmp/result.json', new TextEncoder().encode(JSON.stringify({ code: st.code, childPid: pid, me: t.pid, out: st.stdout, gone })))
       }`,
    )
    await sh.run('/Applications/parent.js')
    return JSON.parse(await sh.cat('/tmp/result.json'))
  })
  expect(out.code).toBe(5)
  expect(out.out).toBe(`child of ${out.me}\n`)
  expect(out.childPid).toBeGreaterThan(out.me)
  expect(out.gone).toBe('ESRCH') // waiting reaped it
})

test('a child inherits the parent environment and working directory', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { sh } = window
    await sh.install(
      '/Applications/kid.js',
      `export default async (t) => { await t.writeFile('kid.json', new TextEncoder().encode(JSON.stringify({ cwd: await t.getcwd(), v: await t.getenv('V'), w: await t.getenv('W') }))) }`,
    )
    await sh.install(
      '/Applications/mom.js',
      `export default async (t) => {
         await t.chdir('/Users')
         await t.setenv('V', 'from-parent')
         await t.wait(await t.spawn('/Applications/kid.js', { env: { W: 'from-spawn' } }))
       }`,
    )
    await sh.run('/Applications/mom.js')
    return JSON.parse(await sh.cat('/Users/kid.json'))
  })
  expect(out).toEqual({ cwd: '/Users', v: 'from-parent', w: 'from-spawn' })
})

test('orphans are adopted by init and cleaned up when they finish', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/orphan.js',
      `export default async (t) => {
         await new Promise((r) => setTimeout(r, 300))
         await t.writeFile('/tmp/orphan-ppid', new TextEncoder().encode(String(await t.getppid())))
       }`,
    )
    await sh.install(
      '/Applications/abandon.js',
      `export default async (t) => { await t.spawn('/Applications/orphan.js') /* never waits */ }`,
    )
    const parent = await kernel.spawn('/Applications/abandon.js')
    await kernel.wait(parent)
    await sh.waitFor('/tmp/orphan-ppid')
    await sh.sleep(100)
    return { ppid: await sh.cat('/tmp/orphan-ppid'), left: await kernel.listProcesses() }
  })
  expect(out.ppid).toBe('1')
  expect(out.left).toEqual([])
})

test('finished processes show as zombies until their parent waits', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install('/Applications/quick.js', `export default () => 4`)
    const pid = await kernel.spawn('/Applications/quick.js')
    let info = await kernel.processInfo(pid)
    for (let i = 0; i < 200 && info.state !== 'zombie'; i++) {
      await sh.sleep(10)
      info = await kernel.processInfo(pid)
    }
    const zombie = { state: info.state, code: info.status?.code, fds: info.openFds }
    const listed = (await kernel.listProcesses()).map((p) => p.pid)
    const status = await kernel.wait(pid)
    const after = await kernel.processInfo(pid).then(() => 'present', (e: { code?: string }) => e.code)
    return { zombie, listed, status, after, pid }
  })
  expect(out.zombie).toEqual({ state: 'zombie', code: 4, fds: 0 })
  expect(out.listed).toContain(out.pid)
  expect(out.status.code).toBe(4)
  expect(out.after).toBe('ESRCH')
})

test('process info reports what the process holds', async ({ page }) => {
  const info = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/hold.js',
      `export default async (t) => {
         await t.chdir('/Users')
         await t.open('/tmp/a', 2 | 0x40); await t.open('/tmp/b', 2 | 0x40)
         await t.writeFile('/tmp/ready', new Uint8Array())
         await new Promise(() => {})
       }`,
    )
    const pid = await kernel.spawn('/Applications/hold.js', { args: ['x'], name: 'holder' })
    await sh.waitFor('/tmp/ready')
    const i = await kernel.processInfo(pid)
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)
    return i
  })
  expect(info).toMatchObject({ ppid: 1, name: 'holder', path: '/Applications/hold.js', args: ['x'], state: 'running', cwd: '/Users', openFds: 2, exitedAt: null })
})

// ------------------------------------------------------------ spawn errors

test('spawn reports missing programs, directories, and bad working directories', async ({ page }) => {
  const codes = await page.evaluate(async () => {
    const { kernel, sh } = window
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e: { code?: string }) => e.code)
    await sh.install('/Applications/ok.js', `export default () => {}`)
    return [
      await code(kernel.spawn('/Applications/missing.js')),
      await code(kernel.spawn('/tmp')),
      await code(kernel.spawn('/Applications/ok.js', { cwd: '/nowhere' })),
      await code(kernel.spawn('/Applications/ok.js', { cwd: '/Applications/ok.js' })),
    ]
  })
  expect(codes).toEqual(['ENOENT', 'EISDIR', 'ENOENT', 'ENOTDIR'])
})

// ------------------------------------------------------------------ scale

test('many processes run at once without interfering', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/worker.js',
      `export default async (t) => {
         const n = t.args[0]
         for (let i = 0; i < 5; i++) await t.writeFile('/tmp/p' + n + '-' + i, new TextEncoder().encode(n))
         console.log('done', n)
         return Number(n)
       }`,
    )
    const pids = await Promise.all(Array.from({ length: 8 }, (_, n) => kernel.spawn('/Applications/worker.js', { args: [String(n)] })))
    const statuses = await Promise.all(pids.map((p) => kernel.wait(p)))
    let files = 0
    for (let n = 0; n < 8; n++) for (let i = 0; i < 5; i++) if ((await sh.cat(`/tmp/p${n}-${i}`)) === String(n)) files++
    return { codes: statuses.map((s) => s.code), outs: statuses.map((s) => s.stdout), files, distinct: new Set(pids).size }
  })
  expect(out.codes).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  expect(out.outs).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map((n) => `done ${n}\n`))
  expect(out.files).toBe(40)
  expect(out.distinct).toBe(8)
})

test('the process limit is enforced', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await sh.install('/Applications/idle.js', `export default () => new Promise(() => {})`)
    const pids: number[] = []
    let failure: string | undefined
    for (let i = 0; i < 70 && !failure; i++) {
      try {
        pids.push(await kernel.spawn('/Applications/idle.js'))
      } catch (e) {
        failure = (e as { code?: string }).code
      }
    }
    await Promise.all(pids.map((p) => kernel.kill(p, 'SIGKILL')))
    await Promise.all(pids.map((p) => kernel.wait(p)))
    return { started: pids.length, failure, after: (await kernel.listProcesses()).length }
  })
  expect(out).toEqual({ started: 64, failure: 'EAGAIN', after: 0 })
})

// ----------------------------------------------------------------- events

test('the kernel reports process events', async ({ page }) => {
  const events = await page.evaluate(async () => {
    const { kernel, sh } = window
    const seen: string[] = []
    const off = kernel.onEvent((e) => e.type === 'process' && seen.push(`${e.event}:${e.pid}`))
    await sh.install('/Applications/ev.js', `export default () => 2`)
    const pid = await kernel.spawn('/Applications/ev.js')
    await kernel.wait(pid)
    off()
    return { seen, pid }
  })
  expect(events.seen).toEqual([`spawned:${events.pid}`, `exited:${events.pid}`])
})

test('shutting down ends running processes', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    await sh.install('/Applications/idle.js', `export default () => new Promise(() => {})`)
    await kernel.spawn('/Applications/idle.js')
    await kernel.spawn('/Applications/idle.js')
    const before = (await kernel.listProcesses()).length
    await kernel.shutdown()
    await kernel.boot({ namespace: ns })
    return { before, after: (await kernel.listProcesses()).length, program: await sh.cat('/Applications/idle.js') }
  }, ns)
  expect(out.before).toBe(2)
  expect(out.after).toBe(0)
  expect(out.program).toContain('export default')
})

// ------------------------------------------------------------- isolation

test('a process cannot reach storage or the network except through the kernel', async ({ page, ns }) => {
  // Processes run in sandboxed iframes (opaque origin, CSP connect-src 'none'), so none of these
  // browser channels may work; the kernel's syscalls are the only way out.
  const verdicts = await page.evaluate(async (ns) => {
    const { sh } = window
    await sh.install(
      '/Applications/sneak.js',
      `export default async (t) => {
         const attempts = {
           opfs: async () => (await (await navigator.storage.getDirectory()).getDirectoryHandle(t.args[0])),
           fetchSameOrigin: () => fetch(location.origin + '/'),
           fetchRemote: () => fetch('https://example.com/'),
           fetchData: () => fetch('http://localhost:4173/main.js'),
           websocket: () => new Promise((res, rej) => { const w = new WebSocket('ws://localhost:4173/'); w.onopen = () => res(); w.onerror = () => rej(new Error('ws blocked')) }),
           beacon: async () => { if (navigator.sendBeacon('http://localhost:4173/x', 'x')) throw new Error('beacon sent') },
           indexedDB: () => new Promise((res, rej) => { const r = indexedDB.open('x'); r.onsuccess = () => res(); r.onerror = () => rej(r.error) }),
           localStorage: async () => localStorage.getItem('x'),
           caches: () => caches.open('x'),
           importRemote: () => import('http://localhost:4173/main.js'),
           importScripts: async () => importScripts('http://localhost:4173/main.js'),
           nestedWorkerRemote: async () => new Worker('http://localhost:4173/process.js'),
           nestedBlobFetch: () => new Promise((res, rej) => {
             const u = URL.createObjectURL(new Blob(["fetch('http://localhost:4173/').then(() => postMessage('open'), () => postMessage('blocked'))"]))
             const w = new Worker(u)
             w.onmessage = (e) => (e.data === 'blocked' ? rej(new Error('blocked')) : res())
             w.onerror = () => rej(new Error('blocked'))
           }),
         }
         const out = {}
         for (const [k, fn] of Object.entries(attempts)) {
           try { await fn(); out[k] = 'REACHED' } catch (e) { out[k] = 'blocked' }
         }
         await t.writeFile('/tmp/verdict', new TextEncoder().encode(JSON.stringify(out)))
       }`,
    )
    await sh.run('/Applications/sneak.js', { args: [ns] })
    return JSON.parse(await sh.cat('/tmp/verdict'))
  }, ns)
  const reached = Object.entries(verdicts).filter(([, v]) => v !== 'blocked')
  expect(reached).toEqual([])
  expect(Object.keys(verdicts).length).toBeGreaterThan(10)
})

test('a process cannot reach the page or other processes', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { sh } = window
    await sh.install(
      '/Applications/peek.js',
      `export default async (t) => {
         const seen = { document: typeof document, window: typeof window, parent: typeof parent, origin: self.origin }
         await t.writeFile('/tmp/peek', new TextEncoder().encode(JSON.stringify(seen)))
       }`,
    )
    await sh.run('/Applications/peek.js')
    return JSON.parse(await sh.cat('/tmp/peek'))
  })
  expect(result).toEqual({ document: 'undefined', window: 'undefined', parent: 'undefined', origin: 'null' })
})

test('process containers are removed when the process ends', async ({ page }) => {
  const frames = await page.evaluate(async () => {
    const { sh, kernel } = window
    await sh.install('/Applications/idle.js', `export default async () => { await new Promise(() => {}) }`)
    const pid = await kernel.spawn('/Applications/idle.js')
    await sh.sleep(300)
    const during = document.querySelectorAll('iframe').length
    await kernel.kill(pid, 'SIGKILL')
    await kernel.wait(pid)
    await sh.sleep(100)
    return { during, after: document.querySelectorAll('iframe').length }
  })
  expect(frames).toEqual({ during: 1, after: 0 })
})
