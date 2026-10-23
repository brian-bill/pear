import { Subscribers, fail, hostBridge, needSystem, serve, subscription, uuid } from './lib'
import type { Pear } from '../src/runtime'

/** The contracts and how far each is implemented (a bump means the request set changed). */
const CONTRACTS: Record<string, number> = {
  conventions: 1, filesystem: 1, processes: 1, ipc: 1, configuration: 1, display: 1, input: 1, audio: 1, clipboard: 1, timers: 1,
  'shell-and-userland': 1, 'app-bundles': 1, 'launch-services': 1, notifications: 1, permissions: 1, 'boot-and-session': 1,
  search: 1, network: 1, 'import-export': 1, 'system-info': 1, logging: 1,
}

interface Host {
  hardware: { cores: number | null; memoryHint: number | null; touch: number; platform: string; userAgent: string; screen: { width: number; height: number; scale: number } | null }
  features: string[]
  languages: string[]
  locale: { calendar: string | null; numbering: string | null; hourCycle: string | null; firstWeekday: number | null; measurement: string | null }
  prefs: { reduceMotion: boolean; reduceTransparency: boolean; highContrast: boolean; colorScheme: 'light' | 'dark' }
  online: boolean
  connection: { effectiveType?: string; downlink?: number; saveData?: boolean } | null
}

const PRESSURE = ['nominal', 'fair', 'serious', 'critical']
const US_MEASURE = new Set(['US', 'LR', 'MM'])
const dec = new TextDecoder()

/**
 * `tiny.system`: facts about the OS and the host (`contracts/system-info.md`). The page's driver pushes what only a page
 * can see (screen, battery, media queries, feature flags); the rest comes from the file system, Intl and settings.
 * Anything the browser does not offer is `null`.
 */
export default async (tiny: Pear) => {
  const host: Host = {
    hardware: { cores: navigator.hardwareConcurrency ?? null, memoryHint: (navigator as { deviceMemory?: number }).deviceMemory ?? null, touch: 0, platform: '', userAgent: navigator.userAgent, screen: null },
    features: [],
    languages: [...(navigator.languages ?? [navigator.language ?? 'en-US'])],
    locale: { calendar: null, numbering: null, hourCycle: null, firstWeekday: null, measurement: null },
    prefs: { reduceMotion: false, reduceTransparency: false, highContrast: false, colorScheme: 'light' },
    online: true,
    connection: null,
  }
  let battery: { level: number; charging: boolean } | null = null
  let pressure: string | null = null
  const watchers = new Subscribers<{ port: number }>(tiny)
  const bridge = hostBridge(tiny, 'system')
  let bootTime = Date.now()
  try {
    bootTime = Number(dec.decode(await tiny.readFile('/var/db/.session')).trim()) || bootTime
  } catch {
    // no session marker (bare kernel)
  }

  const tell = (what: string, value: unknown) => watchers.send({ type: 'changed', what, value })
  const setting = <T>(key: string, fallback: T) => tiny.configGet('tiny.system', key, fallback as never) as Promise<T>

  const release = async () => {
    try {
      const text = dec.decode(await tiny.readFile('/etc/pear-release'))
      return text.trim().replace(/^Pear\s+/, '') || '1.0'
    } catch {
      return '1.0'
    }
  }

  const installId = async () => {
    const path = '/var/db/install-id'
    try {
      return dec.decode(await tiny.readFile(path)).trim()
    } catch {
      const id = uuid()
      await tiny.mkdir('/var/db', { recursive: true }).catch(() => {})
      await tiny.writeFile(path, new TextEncoder().encode(`${id}\n`)).catch(() => {})
      return id
    }
  }

  const locale = async () => {
    const tag = String(await setting('locale', 'en-US'))
    let intl: Intl.Locale
    try {
      intl = new Intl.Locale(tag)
    } catch {
      intl = new Intl.Locale('en-US')
    }
    const region = (await setting<string | null>('region', null)) ?? intl.region ?? host.languages.map((l) => new Intl.Locale(l).region).find(Boolean) ?? 'US'
    const weekInfo = (intl as unknown as { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } })
    const firstDay = weekInfo.getWeekInfo?.().firstDay ?? weekInfo.weekInfo?.firstDay ?? (region === 'US' ? 7 : 1)
    const resolved = new Intl.DateTimeFormat(tag).resolvedOptions()
    return {
      language: intl.language,
      region,
      tag,
      calendar: host.locale.calendar ?? intl.calendar ?? resolved.calendar,
      numbering: host.locale.numbering ?? resolved.numberingSystem,
      hourCycle: host.locale.hourCycle ?? resolved.hourCycle ?? null,
      firstWeekday: (await setting<number | null>('firstWeekday', null)) ?? host.locale.firstWeekday ?? firstDay,
      measurement: (await setting<string | null>('measurement', null)) ?? host.locale.measurement ?? (US_MEASURE.has(region) ? 'us' : 'metric'),
    }
  }

  /** The host's preference, unless the user forced a value; a setting turned on counts too. */
  const accessibility = async () => {
    const over = (await setting<Record<string, unknown>>('accessibilityOverride', {})) ?? {}
    const pick = async (key: 'reduceMotion' | 'reduceTransparency' | 'highContrast') => {
      if (typeof over[key] === 'boolean') return over[key] as boolean
      return host.prefs[key] || (await setting<boolean>(key, false))
    }
    return {
      reduceMotion: await pick('reduceMotion'),
      reduceTransparency: await pick('reduceTransparency'),
      highContrast: await pick('highContrast'),
      textScale: typeof over.textScale === 'number' ? over.textScale : await setting<number>('textScale', 1),
      colorScheme: host.prefs.colorScheme,
    }
  }

  const storage = async () => {
    try {
      return await bridge.call('storage')
    } catch {
      return { quota: null, usage: null, persisted: null }
    }
  }

  const version = async () => {
    const v = await release()
    return { name: 'Pear', version: v, build: `${v}.0`, kernel: `Vanilla ${v}` }
  }

  /** Localized strings: `/System/Library/Localization/<lang>.lproj/<table>.json`, falling back to English, then the key. */
  const strings = new Map<string, Record<string, string> | null>()
  const table = async (lang: string, name: string) => {
    const key = `${lang}/${name}`
    if (strings.has(key)) return strings.get(key)!
    let t: Record<string, string> | null = null
    try {
      t = JSON.parse(dec.decode(await tiny.readFile(`/System/Library/Localization/${lang}.lproj/${name}.json`)))
    } catch {
      t = null
    }
    strings.set(key, t)
    return t
  }

  return serve(
    tiny,
    'tiny.system',
    {
      version,
      capabilities: () => ({ contracts: CONTRACTS, features: host.features }),
      hardware: () => ({ ...host.hardware, cores: host.hardware.cores === null ? null : Math.min(host.hardware.cores, 16), gpu: undefined }),
      storage,
      persist: async (_a, m) => {
        await needSystem(tiny, m, 'ask the browser to keep the storage')
        return bridge.call('persist')
      },
      battery: () => battery,
      thermal: () => pressure,
      pressure: () => pressure,
      uptime: () => Date.now() - bootTime,
      bootTime: () => bootTime,
      hostname: () => setting('hostname', 'pear.local'),
      setHostname: async (a, m) => {
        await needSystem(tiny, m, 'rename the computer')
        if (typeof a.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/.test(a.name)) throw fail('EINVAL', 'a host name is letters, digits, dots and dashes')
        await tiny.configSet('tiny.system', 'hostname', a.name)
        void tell('hostname', a.name)
      },
      installId,
      locale,
      timezone: async () => {
        const z = String(await setting('timezone', 'auto'))
        const zone = z === 'auto' ? Intl.DateTimeFormat().resolvedOptions().timeZone : z
        return { zone, offsetMinutes: -new Date().getTimezoneOffset() }
      },
      preferredLanguages: async () => {
        const set = await setting<string[]>('languages', [])
        return set.length ? set : host.languages
      },
      accessibilityPrefs: accessibility,
      network: () => ({ online: host.online, ...(host.connection ?? {}) }),
      /** Everything "About This Mac" shows, in one round trip. */
      snapshot: async () => ({
        version: await version(), hardware: { ...host.hardware }, storage: await storage(), uptime: Date.now() - bootTime, hostname: await setting('hostname', 'pear.local'),
        locale: await locale(), battery, pressure, features: host.features, installId: await installId(),
      }),
      localize: async (a) => {
        const tag = String(a.language ?? (await locale()).language)
        const name = String(a.table ?? 'Localizable')
        for (const lang of [tag, tag.split('-')[0]!, 'en']) {
          const t = await table(lang, name)
          if (t && typeof t[a.key] === 'string') return a.args ? String(t[a.key]).replace(/\{(\w+)\}/g, (_, k) => String(a.args[k] ?? `{${k}}`)) : t[a.key]
        }
        return String(a.key)
      },
      format: async (a) => {
        const tag = String(a.locale ?? (await locale()).tag)
        const o = (a.options ?? {}) as Record<string, any>
        switch (a.kind) {
          case 'number': return new Intl.NumberFormat(tag, o).format(a.value)
          case 'date': return new Intl.DateTimeFormat(tag, { timeZone: (await timezoneOf()), ...o }).format(new Date(a.value))
          case 'relative': return new Intl.RelativeTimeFormat(tag, o).format(a.value, a.unit)
          case 'list': return new Intl.ListFormat(tag, o).format(a.value)
          case 'bytes': {
            const units = ['B', 'KB', 'MB', 'GB', 'TB']
            let v = Number(a.value)
            let i = 0
            while (v >= 1000 && i < units.length - 1) (v /= 1000), i++
            return `${new Intl.NumberFormat(tag, { maximumFractionDigits: i ? 1 : 0 }).format(v)} ${units[i]}`
          }
          default: throw fail('EINVAL', 'kind is number, date, relative, list or bytes')
        }
      },
      ...subscription(watchers),
    },
    // the page pushes
    async (d) => {
      if (d?.type === 'config-changed') {
        void tell('settings', { key: d.key })
        if (['reduceMotion', 'reduceTransparency', 'highContrast', 'textScale', 'accessibilityOverride'].includes(d.key)) void tell('accessibility', await accessibility())
        return
      }
      const data = d?.type === 'driver' ? d.data : null
      if (!data || bridge.reply(data)) return
      switch (data.event) {
        case 'host': {
          const before = JSON.stringify(host.prefs)
          Object.assign(host, {
            hardware: { ...host.hardware, ...data.hardware },
            features: data.features ?? host.features,
            languages: data.languages ?? host.languages,
            locale: { ...host.locale, ...data.locale },
            prefs: { ...host.prefs, ...data.prefs },
          })
          if (JSON.stringify(host.prefs) !== before) void tell('accessibility', await accessibility())
          break
        }
        case 'battery':
          battery = data.battery
          void tell('battery', battery)
          break
        case 'pressure':
          if (PRESSURE.includes(data.state)) {
            pressure = data.state
            void tell('pressure', pressure)
          }
          break
        case 'online':
          host.online = Boolean(data.online)
          host.connection = data.connection ?? host.connection
          void tell('network', { online: host.online, ...(host.connection ?? {}) })
          break
      }
    },
    // settings that change what we report
    async (port) => void (await tiny.configWatch('tiny.system', null, port)),
  )

  async function timezoneOf() {
    const z = String(await setting('timezone', 'auto'))
    return z === 'auto' ? undefined : z
  }
}
