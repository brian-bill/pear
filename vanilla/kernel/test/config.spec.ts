/** Settings: namespaced keys on LocalStorage with an in-memory cache, schemas, scopes, watchers, and other tabs. */
import { expect, test } from './fixtures'

test('values are typed JSON; user overrides system; defaults come from schemas', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel } = window
    const code = (p: Promise<unknown>) => p.then(() => 'ok', (e) => e.code)
    const r: Record<string, unknown> = {}
    r.wellKnown = [await kernel.configGet('tiny.system', 'appearance'), await kernel.configGet('tiny.desktop.dock', 'position')]
    r.missing = [await kernel.configGet('tiny.test', 'nope'), await kernel.configGet('tiny.test', 'nope', 'fallback')]
    await kernel.configSet('tiny.test', 'obj', { a: [1, 2, { b: null }], c: 'x' })
    r.obj = await kernel.configGet('tiny.test', 'obj')
    await kernel.configSet('tiny.test', 'layer', 'system value', { scope: 'system' })
    r.system = await kernel.configGet('tiny.test', 'layer')
    await kernel.configSet('tiny.test', 'layer', 'user value')
    r.user = await kernel.configGet('tiny.test', 'layer')
    await kernel.configDelete('tiny.test', 'layer')
    r.back = await kernel.configGet('tiny.test', 'layer')
    r.list = await kernel.configList('tiny.test')
    r.domains = await kernel.configDomains()

    await kernel.configSet('tiny.system', 'appearance', 'dark')
    r.invalidEnum = await code(kernel.configSet('tiny.system', 'appearance', 'purple'))
    r.invalidType = await code(kernel.configSet('tiny.system', 'textScale', 'big'))
    r.notJson = await code(kernel.configSet('tiny.test', 'f', undefined))
    r.tooBig = await code(kernel.configSet('tiny.test', 'big', 'x'.repeat(70 * 1024)))
    r.badDomain = await code(kernel.configSet('has space', 'k', 1))
    r.badKey = await code(kernel.configSet('tiny.test', '', 1))
    r.badScope = await code(kernel.configSet('tiny.test', 'k', 1, { scope: 'world' as never }))
    await kernel.configRegister('tiny.test2', { level: { type: 'number', default: 3 } })
    r.registered = [await kernel.configGet('tiny.test2', 'level'), await code(kernel.configSet('tiny.test2', 'level', 'x'))]

    await kernel.configReset('tiny.test')
    r.afterReset = await kernel.configList('tiny.test')
    r.appearanceKept = await kernel.configGet('tiny.system', 'appearance')
    return r
  })
  expect(out.wellKnown).toEqual(['auto', 'bottom'])
  expect(out.missing).toEqual([null, 'fallback'])
  expect(out.obj).toEqual({ a: [1, 2, { b: null }], c: 'x' })
  expect(out.system).toBe('system value')
  expect(out.user).toBe('user value')
  expect(out.back).toBe('system value')
  expect(out.list).toMatchObject({ obj: { c: 'x' }, layer: 'system value' })
  expect(out.domains).toEqual(['tiny.test'])
  expect([out.invalidEnum, out.invalidType, out.notJson, out.badDomain, out.badKey, out.badScope]).toEqual(Array(6).fill('EINVAL'))
  expect(out.tooBig).toBe('E2BIG')
  expect(out.registered).toEqual([3, 'EINVAL'])
  expect(out.afterReset).toEqual({ layer: 'system value' }) // only the user scope was reset
  expect(out.appearanceKept).toBe('dark') // another domain
})

test('settings are written to LocalStorage under namespaced keys and read back at the next boot', async ({ page, ns }) => {
  const stored = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    await kernel.configSet('tiny.desktop.dock', 'size', 64)
    await kernel.configSet('tiny.desktop.dock', 'autohide', true)
    await kernel.configSet('tiny.test', 'system-wide', 'yes', { scope: 'system' })
    await sh.sleep(200) // writes are batched
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(`tiny:${ns}:cfg:`)).sort()
    const user = JSON.parse(localStorage.getItem(`tiny:${ns}:cfg:user:tiny.desktop.dock`)!)
    await kernel.configDelete('tiny.desktop.dock', 'autohide')
    await kernel.configDelete('tiny.desktop.dock', 'size')
    await kernel.configSet('tiny.desktop.dock', 'size', 80)
    await kernel.configSet('tiny.test', 'last-second', 'kept') // not yet written: the next boot is a crash
    await kernel.configFlush()
    await sh.crash(ns)
    const after = { size: await window.kernel.configGet('tiny.desktop.dock', 'size'), autohide: await window.kernel.configGet('tiny.desktop.dock', 'autohide'), sys: await window.kernel.configGet('tiny.test', 'system-wide'), last: await window.kernel.configGet('tiny.test', 'last-second') }
    return { keys, user, after }
  }, ns)
  expect(stored.keys).toEqual([`tiny:${ns}:cfg:system:tiny.test`, `tiny:${ns}:cfg:user:tiny.desktop.dock`])
  expect(stored.user).toEqual({ size: 64, autohide: true })
  expect(stored.after).toEqual({ size: 80, autohide: false, sys: 'yes', last: 'kept' }) // autohide was deleted: the default
})

test('changes are reported once, and another tab\'s changes arrive as external events', async ({ page, ns }) => {
  const out = await page.evaluate(async (ns) => {
    const { kernel, sh } = window
    const seen: string[] = []
    kernel.onEvent((e) => {
      if (e.type === 'config' && e.event === 'changed') seen.push(`${e.change.domain}.${e.change.key}=${JSON.stringify(e.change.value)}${e.change.external ? ' (other tab)' : ''}`)
    })
    await kernel.configSet('tiny.test', 'a', 1)
    await kernel.configSet('tiny.test', 'a', 1) // no change
    await kernel.configSet('tiny.test', 'a', 2)
    await kernel.configDelete('tiny.test', 'a')
    await kernel.configDelete('tiny.test', 'a') // nothing to delete
    await kernel.configSet('tiny.test', 'sys', 's', { scope: 'system' })
    await kernel.configSet('tiny.test', 'sys', 'u') // overrides
    await kernel.configSet('tiny.test', 'sys', 's2', { scope: 'system' }) // hidden by the user value: no visible change
    seen.push('--')
    // another tab wrote this domain: the browser tells us with a storage event
    const key = `tiny:${ns}:cfg:user:tiny.test`
    const text = JSON.stringify({ sys: 'u', fromTab: [1, 2] })
    localStorage.setItem(key, text)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, storageArea: localStorage }))
    await sh.sleep(100)
    const value = await kernel.configGet('tiny.test', 'fromTab')
    localStorage.removeItem(key)
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: null, storageArea: localStorage }))
    await sh.sleep(100)
    return { seen, value, after: await kernel.configGet('tiny.test', 'sys') }
  }, ns)
  expect(out.seen).toEqual([
    'tiny.test.a=1', 'tiny.test.a=2', 'tiny.test.a=null',
    'tiny.test.sys="s"', 'tiny.test.sys="u"', // the later system write is hidden by the user value: nothing to report
    '--',
    'tiny.test.fromTab=[1,2] (other tab)',
    'tiny.test.sys="s2" (other tab)', // the other tab removed the user values: the system value shows again
    'tiny.test.fromTab=null (other tab)',
  ])
  expect(out.value).toEqual([1, 2])
  expect(out.after).toBe('s2')
})

test('when LocalStorage cannot be written, settings still work and a warning is reported', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    const warnings: string[] = []
    kernel.onEvent((e) => e.type === 'config' && e.event === 'warning' && warnings.push(e.message))
    const original = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new DOMException('quota', 'QuotaExceededError')
    }
    try {
      await kernel.configSet('tiny.test', 'k', 'still here')
      await sh.sleep(200)
    } finally {
      Storage.prototype.setItem = original
    }
    return { value: await kernel.configGet('tiny.test', 'k'), warnings }
  })
  expect(out.value).toBe('still here')
  expect(out.warnings).toHaveLength(1)
  expect(out.warnings[0]).toContain('cannot be saved')
})

test('programs read settings, write their own domain, and can watch for changes', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { kernel, sh } = window
    await kernel.configSet('tiny.system', 'locale', 'de-DE')
    await sh.app(
      'com.example.prefs',
      `export default async (t) => {
         const code = (p) => p.then(() => 'ok', (e) => e.code)
         const r = {}
         r.read = await t.configGet('tiny.system', 'locale')
         r.own = await code(t.configSet('com.example.prefs', 'theme', 'dark'))
         r.sub = await code(t.configSet('com.example.prefs.window', 'x', 1))
         r.other = await code(t.configSet('com.example.other', 'theme', 'dark'))
         r.system = await code(t.configSet('tiny.system', 'locale', 'xx'))
         r.systemScope = await code(t.configSet('com.example.prefs', 'k', 1, { scope: 'system' }))
         r.delete = await code(t.configDelete('tiny.desktop.dock', 'size'))
         r.read2 = await t.configGet('com.example.prefs', 'theme')
         const port = await t.portCreate()
         await t.configWatch('tiny.system', 'appearance', port)
         await t.writeFile('/tmp/watching', new Uint8Array(1))
         const m = await t.receive(port, { timeout: 5000 })
         r.event = [m.from, m.data.type, m.data.key, m.data.value]
         console.log(JSON.stringify(r))
       }`,
    )
    const pid = await kernel.launchOpen('com.example.prefs')
    await sh.waitFor('/tmp/watching')
    await kernel.configSet('tiny.system', 'locale', 'fr-FR') // not the key being watched
    await kernel.configSet('tiny.system', 'appearance', 'dark')
    const result = JSON.parse((await kernel.wait(pid)).stdout ?? '')
    return { result, locale: await kernel.configGet('tiny.system', 'locale'), theme: await kernel.configGet('com.example.prefs', 'theme') }
  })
  expect(out.result).toEqual({
    read: 'de-DE', own: 'ok', sub: 'ok', other: 'EACCES', system: 'EACCES', systemScope: 'EACCES', delete: 'EACCES',
    read2: 'dark', event: [0, 'config-changed', 'appearance', 'dark'],
  })
  expect(out.locale).toBe('fr-FR')
  expect(out.theme).toBe('dark')
})
