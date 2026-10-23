/** `tiny.system`: facts about the OS and the host (`contracts/system-info.md`). */
import { expect, test } from './fixtures'

test.use({ system: true, helpers: true })

test('version, capabilities, uptime, install id and host name come from the system itself', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const ask = window.ask
    const id1 = await ask('system', { op: 'installId' })
    const id2 = await ask('system', { op: 'installId' })
    const denied = await window.runApp('org.test.rename', `export default async (tiny) => {
      const r = (await tiny.request(await tiny.lookup('tiny.system'), { op: 'setHostname', name: 'evil' })).data
      await tiny.writeFile('/tmp/org.test.rename.out', new TextEncoder().encode(JSON.stringify(r.ok ? 'ok' : r.error.code)))
    }`)
    await ask('system', { op: 'setHostname', name: 'my-pear' })
    return {
      version: await ask('system', { op: 'version' }), caps: await ask('system', { op: 'capabilities' }),
      uptime: await ask('system', { op: 'uptime' }), id1, id2, denied,
      hostname: await ask('system', { op: 'hostname' }), bad: await ask('system', { op: 'setHostname', name: 'no spaces' }),
      tz: await ask('system', { op: 'timezone' }),
    }
  })
  expect(out.version).toEqual({ name: 'Pear', version: '1.0', build: '1.0.0', kernel: 'Vanilla 1.0' })
  expect(Object.keys(out.caps.contracts)).toHaveLength(21)
  expect(out.uptime).toBeGreaterThan(0)
  expect(out.id1).toMatch(/^[0-9a-f-]{36}$/)
  expect(out.id2).toBe(out.id1)
  expect(out.denied).toBe('EPERM')
  expect(out.hostname).toBe('my-pear')
  expect(out.bad).toEqual({ error: 'EINVAL' })
  expect(out.tz.zone).toMatch(/\w/)
})

test('the page driver supplies hardware, features, locale and host preferences; the user can override', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    const detach = window.attachDrivers()
    await window.sh.sleep(400)
    const inbox = await window.inbox()
    await ask('system', { op: 'subscribe' }, [inbox.port])
    const hw = await ask('system', { op: 'hardware' })
    const caps = await ask('system', { op: 'capabilities' })
    const locale = await ask('system', { op: 'locale' })
    const storage = await ask('system', { op: 'storage' })
    const net = await ask('system', { op: 'network' })
    // a host preference arrives, then the user forces the opposite
    await kernel.driverPush('system', { event: 'host', prefs: { reduceMotion: true } })
    await window.sh.sleep(100)
    const hostSays = await ask('system', { op: 'accessibilityPrefs' })
    await kernel.configSet('tiny.system', 'accessibilityOverride', { reduceMotion: false })
    const forced = await ask('system', { op: 'accessibilityPrefs' })
    await kernel.driverPush('system', { event: 'battery', battery: { level: 0.5, charging: true } })
    await kernel.driverPush('system', { event: 'pressure', state: 'serious' })
    await kernel.driverPush('system', { event: 'pressure', state: 'bogus' })
    const events = await inbox.all(400)
    const battery = await ask('system', { op: 'battery' })
    const pressure = await ask('system', { op: 'thermal' })
    const snapshot = await ask('system', { op: 'snapshot' })
    detach()
    return { hw, caps, locale, storage, net, hostSays, forced, events: events.map((e) => e.what), battery, pressure, snapshot: Object.keys(snapshot) }
  })
  expect(out.hw.cores).toBeGreaterThan(0)
  expect(out.hw.cores).toBeLessThanOrEqual(16)
  expect(out.hw.userAgent).toMatch(/Chrome/)
  expect(out.caps.features).toEqual(expect.arrayContaining(['opfs', 'offscreenCanvas']))
  expect(out.locale).toMatchObject({ language: 'en', tag: 'en-US' })
  expect(['metric', 'us']).toContain(out.locale.measurement)
  expect(out.storage.quota).toBeGreaterThan(0)
  expect(out.net.online).toBe(true)
  expect(out.hostSays.reduceMotion).toBe(true)
  expect(out.forced.reduceMotion).toBe(false)
  expect(out.events).toEqual(expect.arrayContaining(['accessibility', 'battery', 'pressure']))
  expect(out.battery).toEqual({ level: 0.5, charging: true })
  expect(out.pressure).toBe('serious') // the bogus state was ignored
  expect(out.snapshot).toEqual(expect.arrayContaining(['version', 'hardware', 'storage', 'locale', 'installId']))
})

test('localized strings fall back to English then the key; formatting follows the locale', async ({ page }) => {
  const out = await page.evaluate(async () => {
    const { ask, kernel } = window
    await kernel.mkdir('/System/Library/Localization/en.lproj', { recursive: true })
    await kernel.mkdir('/System/Library/Localization/fr.lproj', { recursive: true })
    const enc = new TextEncoder()
    await kernel.writeFile('/System/Library/Localization/en.lproj/Localizable.json', enc.encode(JSON.stringify({ hello: 'Hello, {name}!', bye: 'Goodbye' })))
    await kernel.writeFile('/System/Library/Localization/fr.lproj/Localizable.json', enc.encode(JSON.stringify({ hello: 'Bonjour, {name} !' })))
    return {
      en: await ask('system', { op: 'localize', key: 'hello', args: { name: 'Ada' } }),
      fr: await ask('system', { op: 'localize', key: 'hello', language: 'fr-CA', args: { name: 'Ada' } }),
      fallback: await ask('system', { op: 'localize', key: 'bye', language: 'fr' }),
      missing: await ask('system', { op: 'localize', key: 'nothing' }),
      num: await ask('system', { op: 'format', kind: 'number', value: 1234567.5, locale: 'de-DE' }),
      bytes: await ask('system', { op: 'format', kind: 'bytes', value: 1536000 }),
      list: await ask('system', { op: 'format', kind: 'list', value: ['a', 'b', 'c'] }),
      bad: await ask('system', { op: 'format', kind: 'nope' }),
    }
  })
  expect(out).toEqual({ en: 'Hello, Ada!', fr: 'Bonjour, Ada !', fallback: 'Goodbye', missing: 'nothing', num: '1.234.567,5', bytes: '1.5 MB', list: 'a, b, and c', bad: { error: 'EINVAL' } })
})
