/** The system log, crash reports, diagnostics and traces (`contracts/logging.md`). */
import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })

test('entries are written, filtered and ordered; private ones are redacted in exports', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    await k.logWrite({ level: 'info', subsystem: 'desktop.dock', message: 'dock ready' })
    await k.logWrite({ level: 'error', subsystem: 'desktop.wm', category: 'focus', message: 'lost focus', data: { id: 3 } })
    await k.logWrite({ level: 'debug', subsystem: 'desktop.wm', message: 'secret token abc', private: true })
    const all = await k.logQuery({ subsystem: 'desktop.wm' })
    const errors = await k.logQuery({ level: 'error', text: 'FOCUS' })
    const exported = (await k.logExport()).split('\n').map((l) => JSON.parse(l))
    const withPrivate = (await k.logExport({ includePrivate: true })).split('\n').map((l) => JSON.parse(l))
    await k.logFlush()
    const file = await window.sh.cat('/var/log/system.log')
    await k.logClear()
    return {
      all: all.map((e) => `${e.level}:${e.message}`), errors: errors.map((e) => e.data),
      redacted: exported.find((e: any) => e.subsystem === 'desktop.wm' && e.level === 'debug').message,
      kept: withPrivate.find((e: any) => e.level === 'debug').message,
      onDisk: file.includes('lost focus'),
      afterClear: (await k.logQuery({ subsystem: 'desktop.wm' })).length,
    }
  })
  expect(out.all).toEqual(['error:lost focus', 'debug:secret token abc'])
  expect(out.errors).toEqual([{ id: 3 }])
  expect(out.redacted).toBe('<private>')
  expect(out.kept).toBe('secret token abc')
  expect(out.onDisk).toBe(true)
  expect(out.afterClear).toBe(0)
})

test('boot leaves marks and a log line; app console output is bridged under the app id', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const marks = (await k.bootMarks()).map((m) => m.label)
    const boot = (await k.logQuery({ subsystem: 'boot' })).map((e) => e.message)
    const id = 'org.test.chatty'
    await window.runApp(id, `export default async (tiny) => {
      console.log('hello from the app'); console.error('oops')
      await tiny.logWrite({ level: 'notice', subsystem: 'spoofed', message: 'explicit' })
      const mine = await tiny.logQuery({})
      await tiny.writeFile('/tmp/${id}.out', new TextEncoder().encode(JSON.stringify(mine.map((e) => e.appId + ':' + e.message))))
    }`)
    await window.sh.sleep(100)
    const entries = await k.logQuery({ appId: id })
    return { marks, boot, entries: entries.map((e) => `${e.level}:${e.subsystem}:${e.category}:${e.message}`) }
  })
  expect(out.marks).toContain('boot: ready')
  expect(out.boot[0]).toMatch(/booted/)
  expect(out.entries).toEqual([
    'info:org.test.chatty:console:hello from the app',
    'error:org.test.chatty:console:oops',
    'notice:org.test.chatty:default:explicit', // an app cannot log under another subsystem
  ])
})

test('log volume is rate limited per process and the drops are recorded', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const id = 'org.test.noisy'
    const result = await window.runApp(id, `export default async (tiny) => {
      let kept = 0
      for (let i = 0; i < 600; i++) if (await tiny.logWrite({ message: 'spam ' + i })) kept++
      await tiny.writeFile('/tmp/${id}.out', new TextEncoder().encode(JSON.stringify({ kept })))
    }`)
    await window.sh.sleep(1200)
    const notices = (await k.logQuery({ subsystem: 'logging' })).map((e) => e.message)
    return { kept: result.kept, notices, stats: (await k.diagSnapshot()).log }
  })
  expect(out.kept).toBeLessThan(600)
  expect(out.kept).toBeGreaterThanOrEqual(200)
  expect(out.stats.dropped).toBeGreaterThan(0)
})

test('a crash makes a report with the stack and recent log lines; it can be submitted and cleared', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    const seen: string[] = []
    k.onEvent((e) => e.type === 'crash' && seen.push(e.event))
    await window.sh.install('/tmp/crash.js', `export default async (tiny) => {
      await tiny.logWrite({ message: 'about to fail' })
      throw new Error('boom')
    }`)
    const st = await window.sh.run('/tmp/crash.js')
    await window.sh.sleep(100)
    const list = await k.crashList()
    const report = await k.crashGet(list[0]!.id)
    const submitted = await k.crashSubmit(report.id)
    const onDisk = await k.exists(`/var/log/crashes/${report.id}.json`)
    await k.crashClear()
    return {
      crashed: st.crashed, count: list.length, name: report.name, error: report.error, stderr: report.stderr.includes('boom'),
      recent: report.recent.map((e) => e.message), submitted: submitted.submitted, onDisk, left: (await k.crashList()).length, seen,
    }
  })
  expect(out).toMatchObject({ crashed: true, count: 1, name: 'crash.js', error: 'boom', stderr: true, submitted: true, onDisk: true, left: 0 })
  expect(out.recent).toEqual(['about to fail'])
  expect(out.seen).toEqual(['reported', 'submitted'])
})

test('crash reports and log lines survive a power cut', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const k = window.kernel
    await window.sh.install('/tmp/crash.js', `export default async () => { throw new Error('first') }`)
    await window.sh.run('/tmp/crash.js')
    await window.sh.sleep(100)
    await k.logWrite({ message: 'before the power cut', subsystem: 'desktop.test' })
    await k.logFlush()
    await window.sh.crash(ns, { system: true })
    const k2 = window.kernel
    return { crashes: (await k2.crashList()).length, lines: (await k2.logQuery({ since: 1, text: 'power cut' })).length }
  }, ns)
  expect(out.crashes).toBe(1)
  expect(out.lines).toBe(1)
})

test('diag.snapshot describes processes and traces count syscalls and marks', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const k = window.kernel
    await k.traceStart('t')
    await k.traceMark('t', 'a')
    await window.sh.install('/tmp/work.js', `export default async (tiny) => { await tiny.writeFile('/tmp/w', new Uint8Array(4)); await tiny.stat('/tmp/w') }`)
    await window.sh.run('/tmp/work.js')
    await k.traceMark('t', 'b')
    await k.traceMeasure('t', 'work', 'a', 'b')
    const trace = await k.traceStop('t')
    const snap = await k.diagSnapshot()
    const dup = await k.traceStart('x').then(() => k.traceStart('x')).catch((e: any) => e.code)
    return {
      marks: trace.marks.map((m) => m.label), measure: trace.measures[0]!.name, syscalls: Object.keys(trace.syscalls).includes('writeFile'),
      services: snap.processes.filter((p) => p.state === 'running' && p.bundleId?.startsWith('org.tiny.')).length, ports: snap.ports > 0, uptime: snap.uptime > 0, dup,
    }
  })
  expect(out.marks).toEqual(['a', 'b'])
  expect(out.measure).toBe('work')
  expect(out.syscalls).toBe(true)
  expect(out.services).toBe(13)
  expect(out.ports).toBe(true)
  expect(out.dup).toBe('EEXIST')
})
