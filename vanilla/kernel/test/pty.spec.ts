/**
 * Pseudo-terminals: the line discipline (echo, editing, ^C ^Z ^D, newline translation), window size,
 * hangup, and the session / foreground process group that decides who gets ^C.
 */
import { PRELUDE, expect, test } from './fixtures'

// ------------------------------------------------------------- line discipline

test('line mode: input is held until Enter, CR becomes LF, and typed characters are echoed', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/t.js',
      `${prelude}
       export default async (t) => {
         const { master, slave } = await t.openpty()
         await t.write(master, 'he')
         let early = false
         const pending = t.read(slave, 100)
         pending.then(() => (early = true))
         await sleep(80)
         const heldBack = !early
         await t.write(master, 'llo\\r')
         const line = dec.decode(await pending)
         const echo = dec.decode(await t.read(master, 100))
         await out(t, 't.json', { heldBack, line, echo })
       }`,
    )
    const st = await sh.run('/Applications/t.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/t.json')) }
  }, PRELUDE)
  expect(res).toEqual({ err: '', heldBack: true, line: 'hello\n', echo: 'hello\r\n' })
})

test('line editing: Backspace, ^U, ^W, UTF-8 aware, and a line is delivered whole even to small reads', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/t.js',
      `${prelude}
       export default async (t) => {
         const { master, slave } = await t.openpty()
         const type = (s) => t.write(master, s)
         const line = async () => dec.decode(await t.read(slave, 100))
         const r = {}
         await type('abc\\x7f\\x7fd\\r'); r.backspace = await line()
         await type('junk\\x15ok\\r'); r.kill = await line()
         await type('one two\\x17three\\r'); r.werase = await line()
         await type('aé\\x7f\\r'); r.utf8 = await line()
         await type('hello world\\r')
         r.small = [dec.decode(await t.read(slave, 5)), dec.decode(await t.read(slave, 100))]
         r.echo = dec.decode(await t.read(master, 1000)).includes('\\b \\b')
         await out(t, 't.json', r)
       }`,
    )
    const st = await sh.run('/Applications/t.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/t.json')) }
  }, PRELUDE)
  expect(res).toEqual({
    err: '',
    backspace: 'ad\n',
    kill: 'ok\n',
    werase: 'one three\n',
    utf8: 'a\n',
    small: ['hello', ' world\n'],
    echo: true,
  })
})

test('^D: end of file on an empty line (once), or hands over a partial line without a newline', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/t.js',
      `${prelude}
       export default async (t) => {
         const { master, slave } = await t.openpty()
         const line = async () => (await t.read(slave, 100))
         await t.write(master, '\\x04')
         const eof = (await line()).length
         await t.write(master, 'ab\\x04')
         const partial = dec.decode(await line())
         await t.write(master, 'c\\r')
         const rest = dec.decode(await line())
         await out(t, 't.json', { eof, partial, rest })
       }`,
    )
    const st = await sh.run('/Applications/t.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/t.json')) }
  }, PRELUDE)
  expect(res).toEqual({ err: '', eof: 0, partial: 'ab', rest: 'c\n' })
})

test('output: LF becomes CRLF (a CR already there is kept); raw mode passes bytes both ways untouched', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/t.js',
      `${prelude}
       export default async (t) => {
         const { master, slave } = await t.openpty()
         await t.write(slave, 'a\\nb\\r\\nc')
         const cooked = dec.decode(await t.read(master, 100))

         await t.setRawMode(true, slave)
         const attrs = await t.tcgetattr(slave)
         let early = false
         const pending = t.read(slave, 100)
         pending.then(() => (early = true))
         await t.write(master, 'xy')
         const typed = dec.decode(await pending) // no Enter needed
         let echoed = false
         const echo = t.read(master, 100)
         echo.then(() => (echoed = true))
         await sleep(80)
         const echoedEarly = echoed

         await t.tcsetattr(slave, { icrnl: false, onlcr: false })
         await t.write(master, '\\r')
         const cr = dec.decode(await t.read(slave, 10))
         await t.write(slave, '\\n')
         const lf = dec.decode(await echo) // the pending read picks it up
         await out(t, 't.json', { cooked, attrs, typed, echoed: echoedEarly, cr, lf })
       }`,
    )
    const st = await sh.run('/Applications/t.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/t.json')) }
  }, PRELUDE)
  expect(res.err).toBe('')
  expect(res.cooked).toBe('a\r\nb\r\nc')
  expect(res.attrs).toMatchObject({ icanon: false, echo: false, isig: false })
  expect(res.typed).toBe('xy')
  expect(res.echoed).toBe(false)
  expect(res.cr).toBe('\r')
  expect(res.lf).toBe('\n')
})

test('terminal calls reject bad settings and non-terminals', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { sh } = window
    await sh.install(
      '/Applications/t.js',
      `${prelude}
       export default async (t) => {
         const { master, slave } = await t.openpty()
         const [r] = await t.pipe()
         await out(t, 't.json', {
           isatty: [await t.isatty(master), await t.isatty(slave), await t.isatty(r), await t.isatty(1)],
           stdoutIsTTY: t.stdout.isTTY,
           badKey: await code(t.tcsetattr(slave, { banana: true })),
           badValue: await code(t.tcsetattr(slave, { echo: 'yes' })),
           badSize: await code(t.setwinsize(slave, { rows: 0, cols: 5 })),
           pipe: await code(t.tcgetattr(r)),
           stdout: await code(t.tcgetattr(1)),
           missing: await code(t.isatty(424242)),
           size: await t.getwinsize(slave),
         })
       }`,
    )
    const st = await sh.run('/Applications/t.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/t.json')) }
  }, PRELUDE)
  expect(res).toEqual({
    err: '',
    isatty: [true, true, false, false],
    stdoutIsTTY: false,
    badKey: 'EINVAL',
    badValue: 'EINVAL',
    badSize: 'EINVAL',
    pipe: 'ENOTTY',
    stdout: 'ENOTTY',
    missing: 'EBADF',
    size: { rows: 24, cols: 80 },
  })
})

// ------------------------------------------------------------- terminal sessions

test('spawnPty: a program talks to a terminal; the emulator side sees echo and output', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/sh.js',
      `${prelude}
       export default async (t) => {
         t.stdout.write('$ ')
         const line = await t.stdin.read()
         const name = dec.decode(line).trim()
         console.log('hello ' + name + ' tty=' + [t.stdin.isTTY, t.stdout.isTTY, t.stderr.isTTY].join())
         const size = await t.getwinsize()
         console.log('size ' + size.cols + 'x' + size.rows)
         return 7
       }`,
    )
    const { pid, master } = await kernel.spawnPty('/Applications/sh.js', { size: { rows: 30, cols: 100 } })
    const prompt = await sh.expect(master, '$ ')
    await kernel.pipeWrite(master, 'bob\r')
    const typed = await sh.expect(master, 'tty=true,true,true\r\n')
    const size = await sh.expect(master, 'size 100x30\r\n')
    const st = await kernel.wait(pid)
    const eof = (await kernel.pipeRead(master)).length // the only slave closed with the process
    const info = { code: st.code, eof }
    return { prompt, typed, size, info }
  }, PRELUDE)
  expect(res.prompt).toBe('$ ')
  expect(res.typed).toBe('bob\r\nhello bob tty=true,true,true\r\n') // echo first, then the program's answer
  expect(res.size).toBe('size 100x30\r\n')
  expect(res.info).toEqual({ code: 7, eof: 0 })
})

test('^C raises SIGINT: a handler runs and pending input is discarded; without one the program dies', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/tough.js',
      `${prelude}
       export default async (t) => {
         t.onSignal('SIGINT', () => console.log('caught'))
         console.log('ready')
         const line = await t.stdin.read()
         console.log('line=' + JSON.stringify(dec.decode(line)))
       }`,
    )
    await sh.install('/Applications/plain.js', `${prelude}\nexport default async (t) => { console.log('ready'); await sleep(100000) }`)

    const tough = await kernel.spawnPty('/Applications/tough.js')
    await sh.expect(tough.master, 'ready\r\n')
    await kernel.pipeWrite(tough.master, 'abc')
    await kernel.pipeWrite(tough.master, '\x03')
    const echo = await sh.expect(tough.master, 'caught\r\n')
    await kernel.pipeWrite(tough.master, 'd\r')
    await sh.expect(tough.master, 'line="d\\n"\r\n')
    const toughStatus = await kernel.wait(tough.pid)

    const plain = await kernel.spawnPty('/Applications/plain.js')
    await sh.expect(plain.master, 'ready\r\n')
    await kernel.pipeWrite(plain.master, '\x03')
    const plainStatus = await kernel.wait(plain.pid)
    return { echo, tough: toughStatus.code, plain: plainStatus.signal }
  }, PRELUDE)
  expect(res.echo).toContain('^C') // the terminal shows ^C
  expect(res.tough).toBe(0)
  expect(res.plain).toBe('SIGINT')
})

test('^Z delivers SIGTSTP; with no handler it is ignored (Workers cannot be suspended)', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/z.js',
      `${prelude}
       export default async (t) => {
         if (t.args[0] === 'handle') t.onSignal('SIGTSTP', () => console.log('tstp'))
         console.log('ready')
         await t.stdin.read()
         console.log('still here')
       }`,
    )
    const run = async (mode: string, wait: string) => {
      const { pid, master } = await kernel.spawnPty('/Applications/z.js', { args: [mode] })
      await sh.expect(master, 'ready\r\n')
      await kernel.pipeWrite(master, '\x1a')
      if (wait) await sh.expect(master, wait)
      await kernel.pipeWrite(master, 'go\r')
      await sh.expect(master, 'still here\r\n')
      return (await kernel.wait(pid)).code
    }
    return { handled: await run('handle', 'tstp\r\n'), ignored: await run('ignore', '') }
  }, PRELUDE)
  expect(res).toEqual({ handled: 0, ignored: 0 })
})

test('resizing the terminal sends SIGWINCH to the foreground group; the program reads the new size', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install(
      '/Applications/w.js',
      `${prelude}
       export default async (t) => {
         t.onSignal('SIGWINCH', async () => {
           const s = await t.getwinsize()
           console.log('winch ' + s.cols + 'x' + s.rows)
         })
         console.log('ready')
         await t.stdin.read()
       }`,
    )
    const { pid, master } = await kernel.spawnPty('/Applications/w.js')
    await sh.expect(master, 'ready\r\n')
    await kernel.setwinsize(master, { rows: 50, cols: 132 })
    const first = await sh.expect(master, 'winch 132x50\r\n')
    await kernel.setwinsize(master, { rows: 50, cols: 132 }) // unchanged: no signal
    await kernel.setwinsize(master, { rows: 10, cols: 20 })
    const second = await sh.expect(master, 'winch 20x10\r\n')
    const size = await kernel.getwinsize(master)
    await kernel.pipeWrite(master, '\x04')
    await kernel.wait(pid)
    return { first, second, size, bad: await kernel.setwinsize(master, { rows: -1, cols: 3 }).then(() => 'ok', (e) => e.code) }
  }, PRELUDE)
  expect(res.first).toBe('winch 132x50\r\n')
  expect(res.second).toBe('winch 20x10\r\n') // exactly one per real change
  expect(res.size).toEqual({ rows: 10, cols: 20 })
  expect(res.bad).toBe('EINVAL')
})

test('closing the terminal hangs up: SIGHUP to the foreground group, EOF for readers', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/waiter.js', `${prelude}\nexport default async (t) => { console.log('ready'); await t.stdin.read(); await sleep(100000) }`)
    await sh.install(
      '/Applications/survivor.js',
      `${prelude}
       export default async (t) => {
         t.onSignal('SIGHUP', () => {})
         console.log('ready')
         const chunk = await t.stdin.read() // hangup makes input end
         await out(t, 'survivor.json', { chunk })
       }`,
    )
    const a = await kernel.spawnPty('/Applications/waiter.js')
    await sh.expect(a.master, 'ready\r\n')
    await kernel.pipeClose(a.master)
    const hung = await kernel.wait(a.pid)

    const b = await kernel.spawnPty('/Applications/survivor.js')
    await sh.expect(b.master, 'ready\r\n')
    await kernel.pipeClose(b.master)
    const st = await kernel.wait(b.pid)
    return { signal: hung.signal, survivor: st.code, saw: JSON.parse(await sh.cat('/tmp/survivor.json')) }
  }, PRELUDE)
  expect(res).toEqual({ signal: 'SIGHUP', survivor: 0, saw: { chunk: null } })
})

// ------------------------------------------------- sessions and process groups

test('^C goes to the foreground process group only: a shell can run a job and survive', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/job.js', `${prelude}\nexport default async (t) => { await sleep(100000) }`)
    await sh.install(
      '/Applications/shell.js',
      `${prelude}
       export default async (t) => {
         const inherit = { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' }
         const job = await t.spawn('/Applications/job.js', { stdio: inherit })
         await t.setpgid(job, job)
         await t.tcsetpgrp(0, job)
         const info = await t.info(job)
         console.log('job running pgid=' + (info.pgid === job) + ' fg=' + ((await t.tcgetpgrp(0)) === job))
         const st = await t.wait(job)
         await t.tcsetpgrp(0, await t.getpgid())
         console.log('job ended by ' + st.signal + ', shell fg again=' + ((await t.tcgetpgrp(0)) === t.pid))
       }`,
    )
    const { pid, master } = await kernel.spawnPty('/Applications/shell.js')
    const running = await sh.expect(master, 'fg=true\r\n')
    await kernel.pipeWrite(master, '\x03')
    const ended = await sh.expect(master, 'fg again=true\r\n')
    const st = await kernel.wait(pid)
    return { running, ended, shell: { code: st.code, signal: st.signal } }
  }, PRELUDE)
  expect(res.running).toBe('job running pgid=true fg=true\r\n')
  expect(res.ended).toContain('job ended by SIGINT')
  expect(res.shell).toEqual({ code: 0, signal: null })
})

test('when the session leader exits, the foreground group gets SIGHUP', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/job.js', `${prelude}\nexport default async (t) => { await sleep(100000) }`)
    await sh.install(
      '/Applications/shell.js',
      `${prelude}
       export default async (t) => {
         const job = await t.spawn('/Applications/job.js', { stdio: { stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' } })
         await t.setpgid(job, job)
         await t.tcsetpgrp(0, job)
         await out(t, 'job.json', job)
       }`,
    )
    const { pid } = await kernel.spawnPty('/Applications/shell.js')
    await kernel.wait(pid)
    const job = JSON.parse(await sh.cat('/tmp/job.json'))
    const st = await kernel.wait(job) // adopted by init when the shell exited
    return { signal: st.signal }
  }, PRELUDE)
  expect(res.signal).toBe('SIGHUP')
})

test('kill(-pgid) signals a whole process group', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/leaf.js', `${prelude}\nexport default async (t) => { await sleep(100000) }`)
    await sh.install(
      '/Applications/parent.js',
      `${prelude}
       export default async (t) => {
         const kids = [await t.spawn('/Applications/leaf.js'), await t.spawn('/Applications/leaf.js')]
         await out(t, 'kids.json', kids)
         await sleep(100000)
       }`,
    )
    const parent = await kernel.spawn('/Applications/parent.js')
    await sh.waitFor('/tmp/kids.json')
    const kids: number[] = JSON.parse(await sh.cat('/tmp/kids.json'))
    const infos = await Promise.all([parent, ...kids].map((p) => kernel.processInfo(p)))
    await kernel.kill(-parent, 'SIGTERM')
    const sigs = await Promise.all([parent, ...kids].map(async (p) => (await kernel.wait(p)).signal))
    const none = await kernel.kill(-999999, 'SIGTERM').then(() => 'ok', (e) => e.code)
    return { groups: infos.map((i) => i.pgid === parent && i.sid === parent), sigs, none }
  }, PRELUDE)
  expect(res).toEqual({ groups: [true, true, true], sigs: ['SIGTERM', 'SIGTERM', 'SIGTERM'], none: 'ESRCH' })
})

test('process group and session calls enforce the rules', async ({ page }) => {
  const res = await page.evaluate(async (prelude) => {
    const { kernel, sh } = window
    await sh.install('/Applications/leaf.js', `${prelude}\nexport default async (t) => { await sleep(100000) }`)
    await sh.install(
      '/Applications/rules.js',
      `${prelude}
       export default async (t) => {
         const kid = await t.spawn('/Applications/leaf.js')
         const r = {}
         r.leaderSetsid = await t.setsid() === t.pid // already a session leader: no-op
         r.moveLeader = await code(t.setpgid(0, 1)) // no such group in the session
         r.stranger = await code(t.setpgid(1, 1)) // pid 1 is the kernel, not a process
         r.noTerminal = await code(t.tcgetpgrp(0)) // stdin is not a terminal
         await t.setpgid(kid, kid)
         r.kidGroup = (await t.getpgid(kid)) === kid
         r.sameSession = (await t.getsid(kid)) === (await t.getsid())
         r.ownGroup = await code(t.setpgid(kid, t.pid)) // back into ours
         r.missing = await code(t.getpgid(999999))
         await t.kill(kid, 'SIGKILL')
         await t.wait(kid)
         await out(t, 'rules.json', r)
       }`,
    )
    const st = await sh.run('/Applications/rules.js')
    return { err: st.stderr, ...JSON.parse(await sh.cat('/tmp/rules.json')) }
  }, PRELUDE)
  expect(res).toEqual({
    err: '',
    leaderSetsid: true,
    moveLeader: 'EPERM',
    stranger: 'ESRCH',
    noTerminal: 'ENOTTY',
    kidGroup: true,
    sameSession: true,
    ownGroup: 'ok',
    missing: 'ESRCH',
  })
})
