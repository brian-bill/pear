/** `tiny.search`: indexing and querying (`contracts/search.md`). */
import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })
test.beforeEach(async ({ page }) => {
  await page.evaluate(() => {
    ;(window as any).indexed = async (ms = 8000) => {
      const t = Date.now()
      while (Date.now() - t < ms) {
        const s = await window.ask('search', { op: 'status' })
        if (!s.indexing && s.lastIndexed) return window.ask('search', { op: 'index.sync' })
        await window.sh.sleep(50)
      }
      throw new Error('indexing did not finish')
    }
    ;(window as any).q = async (text: string, extra: Record<string, unknown> = {}) => {
      const r = await window.ask('search', { op: 'query', q: text, ...extra })
      return r.error ? r : r.results.map((x: any) => x.title)
    }
  })
})

test('files are found by name, content, tag, kind, extension, date and size', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const enc = new TextEncoder()
    const w = (p: string, t: string) => kernel.writeFile(p, enc.encode(t))
    await kernel.mkdir('/Users/pear/Documents/Projects', { recursive: true })
    await w('/Users/pear/Documents/quarterly report.txt', 'revenue grew while pineapple costs fell')
    await w('/Users/pear/Documents/notes.md', '# Notes\nremember the pineapple')
    await w('/Users/pear/Documents/Projects/report-draft.md', 'draft')
    await w('/Users/pear/Documents/photo.png', 'not really a png')
    await w('/Users/pear/Documents/big.log', 'x'.repeat(5000))
    await kernel.setxattr('/Users/pear/Documents/notes.md', 'user.tags', 'Urgent, work')
    await (window as any).indexed()
    const q = (window as any).q
    return {
      name: await q('report'), prefix: await q('quar'), content: await q('pineapple'), tag: await q('tag:urgent'), kind: await q('kind:image'),
      folder: await q('kind:folder proj'), ext: await q('ext:md'), size: await q('size:>1k'), today: await q('date:today notes'), old: await q('date:<2000-01-01 notes'),
      phrase: await q('"quarterly report"'), neg: await q('report -draft'), nameOnly: await q('name:notes'), nothing: await q('zzzzqqq'), empty: await q('   '),
    }
  })
  expect(out.name).toEqual(expect.arrayContaining(['quarterly report.txt', 'report-draft.md']))
  expect(out.name[0]).toBe('report-draft.md') // starts with "report": the prefix beats a word in the middle
  expect(out.prefix).toEqual(['quarterly report.txt'])
  expect(out.content.sort()).toEqual(['notes.md', 'quarterly report.txt'])
  expect(out.tag).toEqual(['notes.md'])
  expect(out.kind).toEqual(['photo.png'])
  expect(out.folder).toEqual(['Projects'])
  expect(out.ext).toEqual(expect.arrayContaining(['notes.md', 'report-draft.md']))
  expect(out.ext).toHaveLength(2)
  expect(out.size).toEqual(['big.log'])
  expect(out.today).toEqual(['notes.md'])
  expect(out.old).toEqual([])
  expect(out.phrase).toEqual(['quarterly report.txt'])
  expect(out.neg).toEqual(['quarterly report.txt'])
  expect(out.nameOnly).toEqual(['notes.md'])
  expect(out.nothing).toEqual([])
  expect(out.empty).toEqual([])
})

test('results are ranked, limited and sortable; content matches rank below name matches', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const enc = new TextEncoder()
    for (const [n, t] of [['alpha.txt', 'zebra'], ['zebra.txt', 'beta'], ['zebra-crossing.txt', 'x'], ['mmm.txt', 'a zebra here']]) await kernel.writeFile(`/Users/pear/Documents/${n}`, enc.encode(t))
    await (window as any).indexed()
    const q = (window as any).q
    return {
      ranked: await q('zebra'), limit: await q('zebra', { limit: 2 }), byName: await q('zebra', { sort: 'name' }),
      scoped: await q('zebra', { scopes: ['/Users/pear/Desktop'] }), types: await q('zebra', { types: ['text'] }),
    }
  })
  expect(out.ranked).toEqual(['zebra.txt', 'zebra-crossing.txt', 'alpha.txt', 'mmm.txt'].sort((a, b) => out.ranked.indexOf(a) - out.ranked.indexOf(b)))
  expect(out.ranked.slice(0, 2)).toEqual(['zebra.txt', 'zebra-crossing.txt'])
  expect(out.limit).toHaveLength(2)
  expect(out.byName).toEqual(['alpha.txt', 'mmm.txt', 'zebra-crossing.txt', 'zebra.txt'])
  expect(out.scoped).toEqual([])
  expect(out.types).toHaveLength(4)
})

test('the index follows changes: new, edited, renamed and deleted files; exclusions hide folders', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, ask, sh } = window
    const enc = new TextEncoder()
    await (window as any).indexed()
    const q = (window as any).q
    const until = async (text: string, want: (r: string[]) => boolean) => {
      for (let i = 0; i < 80; i++) {
        const r = await q(text)
        if (want(r)) return r
        await sh.sleep(100)
      }
      return q(text)
    }
    await kernel.writeFile('/Users/pear/Documents/fresh.txt', enc.encode('quokka'))
    const created = await until('quokka', (r) => r.length === 1)
    await kernel.writeFile('/Users/pear/Documents/fresh.txt', enc.encode('wombat'))
    const edited = [await until('wombat', (r) => r.length === 1), await q('quokka')]
    await kernel.rename('/Users/pear/Documents/fresh.txt', '/Users/pear/Documents/renamed.txt')
    const renamed = await until('renamed', (r) => r.length === 1)
    await kernel.unlink('/Users/pear/Documents/renamed.txt')
    const deleted = await until('wombat', (r) => r.length === 0)
    await kernel.mkdir('/Users/pear/Documents/Private', { recursive: true })
    await kernel.writeFile('/Users/pear/Documents/Private/secret.txt', enc.encode('aardvark'))
    const visible = await until('aardvark', (r) => r.length === 1)
    await ask('search', { op: 'index.exclude', path: '/Users/pear/Documents/Private' })
    const hidden = await q('aardvark')
    const excluded = await ask('search', { op: 'index.excluded' })
    await kernel.writeFile('/Users/pear/Documents/Private/more.txt', enc.encode('aardvark again'))
    await sh.sleep(1500)
    const stillHidden = await q('aardvark')
    await ask('search', { op: 'index.include', path: '/Users/pear/Documents/Private' })
    const back = await until('aardvark', (r) => r.length === 2)
    return { created, edited, renamed, deleted, visible, hidden, excluded, stillHidden, back }
  })
  expect(out.created).toEqual(['fresh.txt'])
  expect(out.edited).toEqual([['fresh.txt'], []])
  expect(out.renamed).toEqual(['renamed.txt'])
  expect(out.deleted).toEqual([])
  expect(out.visible).toEqual(['secret.txt'])
  expect(out.hidden).toEqual([])
  expect(out.excluded).toEqual(['/Users/pear/Documents/Private'])
  expect(out.stillHidden).toEqual([])
  expect(out.back.sort()).toEqual(['more.txt', 'secret.txt'])
})

test('the index is saved and a restart finds it again without reading every file; rebuild recreates it', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    await kernel.writeFile('/Users/pear/Documents/persisted.txt', new TextEncoder().encode('kiwi'))
    await (window as any).indexed()
    await sh.sleep(1500) // let the periodic save run
    const saved = await kernel.exists('/System/Library/Search/index.json')
    await kernel.fsCheckpoint()
    await kernel.flush()
    await sh.crash(ns, { system: true })
    await installH()
    const first = await window.ask('search', { op: 'status' })
    await (window as any).indexed()
    const after = await (window as any).q('kiwi')
    await window.ask('search', { op: 'index.rebuild' })
    const rebuilt = await (async () => { await sh.sleep(100); await (window as any).indexed(); return (window as any).q('kiwi') })()
    return { saved, restoredEarly: first.indexed > 0, after, rebuilt }
    async function installH() {
      // helpers live on window already; just wait for the services
      for (let i = 0; i < 100; i++) { try { await window.kernel.lookup('tiny.search'); return } catch { await sh.sleep(50) } }
    }
  }, ns)
  expect(out.saved).toBe(true)
  expect(out.restoredEarly).toBe(true) // loaded from disk before the new crawl finished
  expect(out.after).toEqual(['persisted.txt'])
  expect(out.rebuilt).toEqual(['persisted.txt'])
})

test('apps are searchable, providers contribute results, and built-ins calculate and convert', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, ask } = window
    await window.sh.app('org.test.calendar', `export default async () => {}`, { name: 'Calendar' }, true)
    await (window as any).indexed()
    const apps = await ask('search', { op: 'query', q: 'calend', scopes: ['apps'] })
    // a provider app answers searches on its own port
    const port = await kernel.portCreate()
    const reg = await ask('search', { op: 'register', id: 'settings', name: 'Settings panes' }, [port])
    const serving = (async () => {
      const m = await kernel.receive(port, { timeout: 5000 })
      await kernel.send(m.replyTo!, { results: [{ title: 'Display', subtitle: 'Settings pane', kind: 'setting', action: { open: 'display' } }] })
    })()
    const viaProvider = await ask('search', { op: 'query', q: 'displ', scopes: ['providers'] })
    await serving
    const list = await ask('search', { op: 'providers' })
    const calc = await ask('search', { op: 'query', q: '2 + 3 * (4 - 1)' })
    const units = await ask('search', { op: 'query', q: '5 km in mi' })
    const temp = await ask('search', { op: 'query', q: '100 c to f' })
    const unsafe = await ask('search', { op: 'query', q: 'process.exit()' })
    return {
      apps: apps.results.map((r: any) => [r.title, r.kind, r.appId]), reg, via: viaProvider.results.map((r: any) => [r.title, r.kind, r.action]), list,
      calc: calc.results[0], units: units.results[0].title, temp: temp.results[0].title, unsafe: unsafe.results.filter((r: any) => r.kind === 'calc'),
    }
  })
  expect(out.apps).toEqual([['Calendar', 'app', 'org.test.calendar']])
  expect(out.via).toEqual([['Display', 'setting', { open: 'display' }]])
  expect(out.list).toEqual([{ id: 'settings', name: 'Settings panes' }])
  expect(out.calc).toMatchObject({ kind: 'calc', title: '11' })
  expect(out.units).toMatch(/^3\.1068\d* mi$/)
  expect(out.temp).toBe('212 F')
  expect(out.unsafe).toEqual([])
})

test('incremental results arrive on a port; apps only see what their permissions allow', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, ask } = window
    const enc = new TextEncoder()
    await kernel.writeFile('/Users/pear/Documents/walrus-home.txt', enc.encode('x'))
    await kernel.mkdir('/Users/pear/Library/Containers/org.test.finder', { recursive: true })
    await kernel.writeFile('/Users/pear/Library/Containers/org.test.finder/walrus-own.txt', enc.encode('x'))
    await (window as any).indexed()
    const inbox = await window.inbox()
    const final = await ask('search', { op: 'query', q: 'walrus', tag: 'q1' }, [inbox.port])
    const batches = await inbox.all(300)
    const askAs = (id: string, grant: boolean, extra: Record<string, unknown> = {}) => window.runApp(id, `export default async (tiny) => {
      const r = (await tiny.request(await tiny.lookup('tiny.search'), { op: 'query', q: 'walrus' })).data
      await tiny.writeFile('/tmp/${id}.out', new TextEncoder().encode(JSON.stringify(r.ok ? r.result.results.map((x) => x.title).sort() : r.error.code)))
    }`, extra, grant)
    const confined = await askAs('org.test.finder', false, { permissions: ['fs.container'] })
    const userFiles = await askAs('org.test.finder2', true, { permissions: ['fs.user'] })
    return { final: final.results.map((r: any) => r.title), batches: batches.map((b) => [b.type, b.tag, b.done]), confined, userFiles }
  })
  expect(out.final.sort()).toEqual(['walrus-home.txt', 'walrus-own.txt']) // the system sees everything
  expect(out.batches[out.batches.length - 1]).toEqual(['results', 'q1', true])
  expect(out.confined).toEqual(['walrus-own.txt'])
  expect(out.userFiles).toEqual(['walrus-home.txt', 'walrus-own.txt'])
})
