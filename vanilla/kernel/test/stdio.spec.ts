/**
 * Pipes and standard streams: pipe(), spawn's stdio option, stdin, backpressure, EOF and EPIPE.
 */
import { PRELUDE, expect, test } from './fixtures'

// ----------------------------------------------------------------------- pipe()

test('pipe(): data written comes out in order, then EOF once the last writer closes', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/p.js',
      `${prelude}
       export default async (t) => {
         const [r, w] = await t.pipe()
         await t.write(w, 'hello ')
         await t.write(w, enc.encode('world'))
         const first = dec.decode(await t.read(r, 4))
         const second = dec.decode(await t.read(r, 100))
         const pending = t.read(r, 10) // nothing to read yet
         let early = false
         pending.then(() => (early = true))
         await sleep(100)
         const stillWaiting = !early
         await t.write(w, 'x')
         const late = dec.decode(await pending)
         await t.close(w)
         const eof = (await t.read(r, 10)).length
         const again = await code(t.close(w))
         await t.close(r)
         await out(t, 'p.json', { first, second, stillWaiting, late, eof, again })
       }`,
    )
    const st = await sh.run('/Applications/p.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/p.json')) }
  }, PRELUDE)
  expect(res).toEqual({ err: '', first: 'hell', second: 'o world', stillWaiting: true, late: 'x', eof: 0, again: 'EBADF' })
})

test('writing to a pipe with no reader is EPIPE, and closing the reader wakes blocked writers', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/p.js',
      `${prelude}
       export default async (t) => {
         const [r, w] = await t.pipe()
         const big = new Uint8Array(300 * 1024)
         const blocked = code(t.write(w, big)) // more than the pipe holds: waits for a reader
         await sleep(100)
         await t.close(r)
         const woken = await blocked
         const after = await code(t.write(w, 'x'))
         await out(t, 'p.json', { woken, after })
       }`,
    )
    const st = await sh.run('/Applications/p.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/p.json')) }
  }, PRELUDE)
  expect(res).toEqual({ err: '', woken: 'EPIPE', after: 'EPIPE' })
})

test('backpressure: a write larger than the pipe waits until the reader has taken enough', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/p.js',
      `${prelude}
       export default async (t) => {
         const [r, w] = await t.pipe()
         const size = 400 * 1024
         const data = new Uint8Array(size)
         for (let i = 0; i < size; i++) data[i] = i % 251
         let done = false
         const writing = t.write(w, data).then(() => (done = true))
         await sleep(150)
         const blockedAtFirst = !done
         let total = 0, bad = 0, reads = 0
         while (total < size) {
           const chunk = await t.read(r, 16 * 1024)
           for (let i = 0; i < chunk.length; i++) if (chunk[i] !== (total + i) % 251) bad++
           total += chunk.length
           reads++
         }
         await writing
         await out(t, 'p.json', { blockedAtFirst, total, bad, done, manyReads: reads > 20 })
       }`,
    )
    const st = await sh.run('/Applications/p.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/p.json')) }
  }, PRELUDE)
  expect(res).toEqual({ err: '', blockedAtFirst: true, total: 400 * 1024, bad: 0, done: true, manyReads: true })
})

// ------------------------------------------------------------------ stdout pipe

test('stdout: "pipe" gives the parent a stream; EOF arrives when the child exits, and capture stays empty', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/talk.js',
      `${prelude}
       export default async (t) => {
         await t.stdout.write('one\\n')
         console.log('two')
         await t.stderr.write('oops\\n')
         return 3
       }`,
    )
    const pid = await kernel.spawn('/Applications/talk.js', { stdio: { stdout: 'pipe', stderr: 'pipe' } })
    const fds = await kernel.stdio(pid)
    const readAll = async (fd: number) => {
      const parts: string[] = []
      for (;;) {
        const chunk = await kernel.pipeRead(fd)
        if (!chunk.length) return parts.join('')
        parts.push(new TextDecoder().decode(chunk))
      }
    }
    const [stdout, stderr] = [await readAll(fds.stdout!), await readAll(fds.stderr!)]
    const st = await kernel.wait(pid)
    return { fds: Object.keys(fds).sort(), stdout, stderr, code: st.code, captured: [st.stdout, st.stderr] }
  }, PRELUDE)
  expect(res).toEqual({ fds: ['stderr', 'stdout'], stdout: 'one\ntwo\n', stderr: 'oops\n', code: 3, captured: ['', ''] })
})

test('a child writing more than the pipe holds waits for the reader, and exits only after everything was read', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/flood.js',
      `${prelude}
       export default async (t) => {
         for (let i = 0; i < 200; i++) console.log('line ' + i + ' ' + 'x'.repeat(2000)) // ~400 KB, never awaited
       }`,
    )
    const pid = await kernel.spawn('/Applications/flood.js', { stdio: { stdout: 'pipe' } })
    const { stdout } = await kernel.stdio(pid)
    await sh.sleep(400)
    const stuck = (await kernel.processInfo(pid)).state // still running: its output has nowhere to go
    let text = ''
    for (;;) {
      const chunk = await kernel.pipeRead(stdout!, 8192)
      if (!chunk.length) break
      text += new TextDecoder().decode(chunk)
    }
    const st = await kernel.wait(pid)
    const lines = text.split('\n').filter(Boolean)
    return { stuck, count: lines.length, ordered: lines.every((l, i) => l.startsWith(`line ${i} `)), code: st.code }
  }, PRELUDE)
  expect(res).toEqual({ stuck: 'running', count: 200, ordered: true, code: 0 })
})

// ------------------------------------------------------------------------ stdin

test('stdin: "pipe" lets the parent feed a child; EOF when the parent closes its end', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/upper.js',
      `${prelude}
       export default async (t) => {
         let n = 0
         for await (const chunk of t.stdin) {
           n += chunk.length
           await t.stdout.write(dec.decode(chunk).toUpperCase())
         }
         await t.stdout.write('[eof after ' + n + ' bytes]')
       }`,
    )
    const pid = await kernel.spawn('/Applications/upper.js', { stdio: { stdin: 'pipe' } })
    const { stdin } = await kernel.stdio(pid)
    await kernel.pipeWrite(stdin!, 'abc')
    await sh.sleep(50)
    await kernel.pipeWrite(stdin!, new TextEncoder().encode('def'))
    const before = (await kernel.processInfo(pid)).state
    await kernel.pipeClose(stdin!)
    const st = await kernel.wait(pid)
    return { before, stdout: st.stdout, code: st.code }
  }, PRELUDE)
  expect(res).toEqual({ before: 'running', stdout: 'ABCDEF[eof after 6 bytes]', code: 0 })
})

test('stdin defaults to null (EOF at once); readAll and text collect the input', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/slurp.js',
      `${prelude}
       export default async (t) => {
         const first = t.args[0] === 'null' ? await t.stdin.read() : undefined
         const all = await t.stdin.text()
         await out(t, 'slurp-' + t.args[0] + '.json', { first, all })
       }`,
    )
    await sh.run('/Applications/slurp.js', { args: ['null'] })
    const pid = await kernel.spawn('/Applications/slurp.js', { args: ['text'], stdio: { stdin: 'pipe' } })
    const { stdin } = await kernel.stdio(pid)
    await kernel.pipeWrite(stdin!, 'héllo ')
    await kernel.pipeWrite(stdin!, 'wörld')
    await kernel.pipeClose(stdin!)
    const st = await kernel.wait(pid)
    return { none: JSON.parse(await sh.cat('/tmp/slurp-null.json')), text: JSON.parse(await sh.cat('/tmp/slurp-text.json')), err: st.stderr }
  }, PRELUDE)
  expect(res.none).toEqual({ first: null, all: '' })
  expect(res.text).toEqual({ all: 'héllo wörld' })
  expect(res.err).toBe('')
})

// -------------------------------------------------------------- null / file / inherit

test('null drops output; file redirects and appends; stdin can come from a file', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/say.js',
      `${prelude}
       export default async (t) => {
         const input = await t.stdin.text()
         await t.stdout.write('out:' + t.args[0] + ':' + input + '\\n')
         await t.stderr.write('err:' + t.args[0] + '\\n')
       }`,
    )
    await kernel.writeFile('/tmp/in.txt', new TextEncoder().encode('from file'))
    const quiet = await kernel.wait(await kernel.spawn('/Applications/say.js', { args: ['q'], stdio: { stdout: 'null', stderr: 'null' } }))
    const first = { stdio: { stdin: { file: '/tmp/in.txt' }, stdout: { file: '/tmp/o.txt' }, stderr: { file: '/tmp/e.txt' } } } as const
    const a = await kernel.wait(await kernel.spawn('/Applications/say.js', { args: ['a'], ...first }))
    const afterFirst = await sh.cat('/tmp/o.txt')
    const b = await kernel.wait(await kernel.spawn('/Applications/say.js', { args: ['b'], stdio: { stdout: { file: '/tmp/o.txt', append: true } } }))
    const appended = await sh.cat('/tmp/o.txt')
    const c = await kernel.wait(await kernel.spawn('/Applications/say.js', { args: ['c'], stdio: { stdout: { file: '/tmp/o.txt' } } }))
    return {
      quiet: [quiet.stdout, quiet.stderr],
      afterFirst,
      appended,
      truncated: await sh.cat('/tmp/o.txt'),
      err: await sh.cat('/tmp/e.txt'),
      captured: [a.stdout, b.stderr, c.code],
    }
  }, PRELUDE)
  expect(res).toEqual({
    quiet: ['', ''],
    afterFirst: 'out:a:from file\n',
    appended: 'out:a:from file\nout:b:\n',
    truncated: 'out:c:\n',
    err: 'err:a\n',
    captured: ['', 'err:b\n', 0],
  })
})

test('inherit shares the parent stream: a pipe, or the parent\'s captured output', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/kid.js', `${prelude}\nexport default async (t) => { console.log('kid ' + t.args[0]) }`)
    await sh.install(
      '/Applications/parent.js',
      `${prelude}
       export default async (t) => {
         console.log('parent first')
         const pid = await t.spawn('/Applications/kid.js', { args: ['1'], stdio: { stdout: 'inherit' } })
         await t.wait(pid)
         console.log('parent last')
       }`,
    )
    const captured = await sh.run('/Applications/parent.js')
    const pid = await kernel.spawn('/Applications/parent.js', { stdio: { stdout: 'pipe' } })
    const { stdout } = await kernel.stdio(pid)
    let text = ''
    for (;;) {
      const chunk = await kernel.pipeRead(stdout!)
      if (!chunk.length) break
      text += new TextDecoder().decode(chunk)
    }
    await kernel.wait(pid)
    return { captured: captured.stdout, piped: text }
  }, PRELUDE)
  expect(res.captured).toBe('parent first\nkid 1\nparent last\n')
  expect(res.piped).toBe('parent first\nkid 1\nparent last\n')
})

// -------------------------------------------------------------------- pipelines

test('a pipeline: init connects a producer to a consumer with {fd}, and EOF flows once init closes its copies', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/producer.js',
      `${prelude}
       export default async (t) => { for (let i = 1; i <= 5; i++) await t.stdout.write('item ' + i + '\\n') }`,
    )
    await sh.install(
      '/Applications/consumer.js',
      `${prelude}
       export default async (t) => {
         const text = await t.stdin.text()
         console.log(text.split('\\n').filter(Boolean).map((l) => l.toUpperCase()).join(','))
       }`,
    )
    const [r, w] = await kernel.pipe()
    const consumer = await kernel.spawn('/Applications/consumer.js', { stdio: { stdin: { fd: r } } })
    const producer = await kernel.spawn('/Applications/producer.js', { stdio: { stdout: { fd: w } } })
    await kernel.wait(producer)
    // The consumer must not see EOF while init still holds the write end.
    await sh.sleep(150)
    const beforeClose = (await kernel.processInfo(consumer)).state
    await kernel.pipeClose(w)
    await kernel.pipeClose(r)
    const st = await kernel.wait(consumer)
    return { beforeClose, out: st.stdout, code: st.code, err: st.stderr }
  }, PRELUDE)
  expect(res).toEqual({ beforeClose: 'running', out: 'ITEM 1,ITEM 2,ITEM 3,ITEM 4,ITEM 5\n', code: 0, err: '' })
})

// ------------------------------------------------------------------ EPIPE / SIGPIPE

test('output to a pipe nobody reads any more: unhandled EPIPE ends the process with SIGPIPE, handled EPIPE is an error', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/yes.js',
      `${prelude}
       export default async (t) => { for (;;) await t.stdout.write('y\\n') }`,
    )
    await sh.install(
      '/Applications/careful.js',
      `${prelude}
       export default async (t) => {
         let caught = 'none'
         for (let i = 0; i < 100000 && caught === 'none'; i++) {
           try { await t.stdout.write('y\\n') } catch (e) { caught = e.code }
         }
         console.error('caught ' + caught)
         return caught === 'EPIPE' ? 0 : 1
       }`,
    )
    await sh.install(
      '/Applications/chatty.js',
      `${prelude}
       export default async (t) => { for (;;) { console.log('y'); await sleep(1) } }`,
    )
    const results: Record<string, unknown> = {}
    for (const name of ['yes', 'careful', 'chatty']) {
      const pid = await kernel.spawn(`/Applications/${name}.js`, { stdio: { stdout: 'pipe' } })
      const { stdout } = await kernel.stdio(pid)
      await kernel.pipeRead(stdout!, 16) // it is running and writing
      await kernel.pipeClose(stdout!) // ... and now nobody reads
      const st = await kernel.wait(pid)
      results[name] = { code: st.code, signal: st.signal, stderr: st.stderr }
    }
    return results
  }, PRELUDE)
  expect(res.yes).toMatchObject({ code: null, signal: 'SIGPIPE' })
  expect(res.careful).toMatchObject({ code: 0, signal: null, stderr: 'caught EPIPE\n' })
  expect(res.chatty).toMatchObject({ code: null, signal: 'SIGPIPE' })
})

test('descriptors die with the process: the reader sees EOF, and a writer sees EPIPE once its reader process is gone', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/leaky.js',
      `${prelude}
       export default async (t) => {
         const [r, w] = await t.pipe()
         await t.write(w, 'x')
         // Exit without closing anything. Its own stdout is the parent's pipe.
         await t.stdout.write(String((await t.info(t.pid)).openFds))
       }`,
    )
    const pid = await kernel.spawn('/Applications/leaky.js', { stdio: { stdout: 'pipe' } })
    const { stdout } = await kernel.stdio(pid)
    const chunk = await kernel.pipeRead(stdout!)
    const openWhileRunning = new TextDecoder().decode(chunk)
    const eof = (await kernel.pipeRead(stdout!)).length // closed with the process
    const st = await kernel.wait(pid)
    const info = st.pid ? true : false
    return { openWhileRunning, eof, info }
  }, PRELUDE)
  expect(res).toEqual({ openWhileRunning: '2', eof: 0, info: true })
})

// --------------------------------------------------------------------- validation

test('bad stdio options and descriptors are rejected without leaking a process', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/noop.js', `export default async () => {}`)
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code)
    const [r, w] = await kernel.pipe()
    const before = (await kernel.listProcesses()).length
    const out = {
      captureStdin: await code(kernel.spawn('/Applications/noop.js', { stdio: { stdin: 'capture' } })),
      junk: await code(kernel.spawn('/Applications/noop.js', { stdio: { stdout: 'banana' as never } })),
      missingFd: await code(kernel.spawn('/Applications/noop.js', { stdio: { stdout: { fd: 424242 } } })),
      wrongDirection: await code(kernel.spawn('/Applications/noop.js', { stdio: { stdout: { fd: r } } })),
      wrongDirection2: await code(kernel.spawn('/Applications/noop.js', { stdio: { stdin: { fd: w } } })),
      missingFile: await code(kernel.spawn('/Applications/noop.js', { stdio: { stdin: { file: '/nope/none' } } })),
      notAPipe: await code(kernel.pipeRead(12345)),
      closeTwice: [await code(kernel.pipeClose(r)), await code(kernel.pipeClose(r))],
      notYourChild: await code(kernel.stdio(1)),
      after: (await kernel.listProcesses()).length - before,
    }
    // A pipe fd is private to its holder: a process cannot use init's.
    await sh.install(
      '/Applications/thief.js',
      `${prelude}\nexport default async (t) => { await out(t, 'thief.json', await code(t.write(Number(t.args[0]), 'x'))) }`,
    )
    await sh.run('/Applications/thief.js', { args: [String(w)] })
    return { ...out, thief: JSON.parse(await sh.cat('/tmp/thief.json')) }
  }, PRELUDE)
  expect(res).toEqual({
    captureStdin: 'EINVAL',
    junk: 'EINVAL',
    missingFd: 'EBADF',
    wrongDirection: 'EINVAL',
    wrongDirection2: 'EINVAL',
    missingFile: 'ENOENT',
    notAPipe: 'EBADF',
    closeTwice: ['ok', 'EBADF'],
    notYourChild: expect.stringMatching(/ESRCH|EPERM/),
    after: 0,
    thief: 'EBADF',
  })
})

test('signals still end a process blocked on stdin or on a full pipe', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/reader.js', `${prelude}\nexport default async (t) => { await t.stdin.read() }`)
    await sh.install('/Applications/writer.js', `${prelude}\nexport default async (t) => { await t.stdout.write(new Uint8Array(1 << 20)) }`)
    const a = await kernel.spawn('/Applications/reader.js', { stdio: { stdin: 'pipe' } })
    const b = await kernel.spawn('/Applications/writer.js', { stdio: { stdout: 'pipe' } })
    await sh.sleep(300)
    await kernel.kill(a, 'SIGTERM')
    await kernel.kill(b, 'SIGTERM')
    const [sa, sb] = [await kernel.wait(a), await kernel.wait(b)]
    return { a: sa.signal, b: sb.signal }
  }, PRELUDE)
  expect(res).toEqual({ a: 'SIGTERM', b: 'SIGTERM' })
})
