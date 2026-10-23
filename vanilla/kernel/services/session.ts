import { Subscribers, callerInfo, fail, hostBridge, needPort, needSystem, serve, subscription, uuid } from './lib'
import type { Pear } from '../src/runtime'

const SESSION_FILE = '/var/db/session.json'
const SAFE_MARK = '/var/db/.safemode'
const SESSION_VERSION = 1
const MAX_STATE_BYTES = 4 * 1024 * 1024
const SAVE_EVERY_MS = 15_000
const GRACE_MS = 1500
const enc = new TextEncoder()
const dec = new TextDecoder()

/** SHA-256, in plain JS: `crypto.subtle` is not there in every sandboxed context. */
function sha256(text: string): string {
  const K = new Uint32Array(64)
  for (let i = 0, n = 2; i < 64; n++) {
    let prime = true
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false
    if (prime) K[i++] = (Math.cbrt(n) % 1) * 2 ** 32
  }
  const H = new Uint32Array(8)
  for (let i = 0, n = 2; i < 8; n++) {
    let prime = true
    for (let d = 2; d * d <= n; d++) if (n % d === 0) prime = false
    if (prime) H[i++] = (Math.sqrt(n) % 1) * 2 ** 32
  }
  const bytes = enc.encode(text)
  const len = bytes.length
  const padded = new Uint8Array(((len + 9 + 63) >> 6) << 6)
  padded.set(bytes)
  padded[len] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((len * 8) / 2 ** 32))
  view.setUint32(padded.length - 4, (len * 8) >>> 0)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, h] = H as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const t1 = (h! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0
      h = g; g = f; f = e; e = (d! + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, h].forEach((v, i) => (H[i] = (H[i]! + v!) >>> 0))
  }
  return [...H].map((v) => v.toString(16).padStart(8, '0')).join('')
}

type Phase = 'running' | 'asleep' | 'shuttingDown' | 'poweredOff'

interface Saved {
  version: number
  savedAt: number
  state: unknown
  apps: Record<string, unknown>
}

/**
 * `tiny.session`: session save and restore, power states, the lock screen, startup items, safe mode and update
 * notices (`contracts/boot-and-session.md`). Desktop is the session manager: it registers a port, and when the
 * session is saved the service asks it (and every registered app) for its state.
 */
export default async (tiny: Pear) => {
  const watchers = new Subscribers<{ port: number }>(tiny)
  const bridge = hostBridge(tiny, 'session')
  const apps = new Map<string, number>() // appId -> port that answers {type: 'save-state'}
  let manager: number | null = null
  let phase: Phase = 'running'
  let locked = false
  let dirty = false
  let saving: Promise<unknown> | null = null
  let update: { ready: boolean; version?: string } = { ready: false }
  let appStates: Record<string, unknown> = {}
  let visible = true
  let online = true
  /** `watch` wants a port of ours to notify; the request loop's own port serves (set once it exists). */
  let notifyPort = 0
  const startedAt = Date.now()

  const safeMode = await tiny.exists(SAFE_MARK).catch(() => false)
  const log = (level: 'info' | 'notice' | 'error', message: string, data?: unknown) => void tiny.logWrite({ level, subsystem: 'session', message, data }).catch(() => {})
  const tell = (event: unknown) => watchers.send(event)
  const setting = <T>(key: string, fallback: T) => tiny.configGet('tiny.session', key, fallback as never) as Promise<T>

  const read = async (): Promise<Saved | null> => {
    try {
      const j = JSON.parse(dec.decode(await tiny.readFile(SESSION_FILE))) as Saved
      if (j.version !== SESSION_VERSION || typeof j.savedAt !== 'number') throw new Error('unknown format')
      return j
    } catch (e) {
      if ((e as { code?: string }).code === 'ENOENT') return null
      // corrupt or from another version: start fresh
      log('error', `session data discarded: ${(e as Error).message}`)
      await tiny.unlink(SESSION_FILE).catch(() => {})
      return null
    }
  }

  const write = async (state: unknown, apps_: Record<string, unknown>) => {
    const body = JSON.stringify({ version: SESSION_VERSION, savedAt: Date.now(), state, apps: apps_ } satisfies Saved)
    if (body.length > MAX_STATE_BYTES) throw fail('EFBIG', 'the session is too large to save')
    await tiny.mkdir('/var/db', { recursive: true }).catch(() => {})
    await tiny.writeFileAtomic(SESSION_FILE, enc.encode(body))
    await tiny.flush() // a saved session must survive a power cut
    dirty = false
  }

  const saveAll = async (): Promise<{ savedAt: number; apps: string[] }> => {
    if (saving) return saving as Promise<{ savedAt: number; apps: string[] }>
    saving = (async () => {
      try {
        const states: Record<string, unknown> = { ...appStates }
        const saved: string[] = []
        await Promise.all([...apps].map(async ([id, port]) => {
          try {
            const r = await tiny.request(port, { type: 'save-state' }, { timeout: 800 })
            const d = r.data as { ok?: boolean; state?: unknown } | undefined
            if (d?.state !== undefined) (states[id] = d.state), saved.push(id)
          } catch {
            // the app did not answer: keep what it saved last
          }
        }))
        let managed: unknown = (await read())?.state ?? null
        if (manager !== null) {
          try {
            const r = await tiny.request(manager, { type: 'save-state' }, { timeout: 1000 })
            const d = r.data as { state?: unknown } | undefined
            if (d && 'state' in d) managed = d.state
          } catch {
            // keep the previous desktop state
          }
        }
        appStates = states
        await write(managed, states)
        return { savedAt: Date.now(), apps: saved }
      } finally {
        saving = null
      }
    })()
    return saving as Promise<{ savedAt: number; apps: string[] }>
  }

  const policy = async (): Promise<'restore' | 'ask' | 'skip'> => {
    if (safeMode) return 'skip'
    const prev = dec.decode(await tiny.readFile('/var/db/.previous').catch(() => enc.encode('clean'))).trim()
    if (prev !== 'crash') return 'restore'
    const p = await setting<string>('restoreOnCrash', 'ask')
    return p === 'always' ? 'restore' : p === 'never' ? 'skip' : 'ask'
  }

  const power = async (kind: 'shutdown' | 'restart' | 'sleep') => {
    if (phase === 'shuttingDown' || phase === 'poweredOff') throw fail('EBUSY', 'the system is already shutting down')
    const sleeping = kind === 'sleep'
    phase = sleeping ? 'asleep' : 'shuttingDown'
    await tell({ type: sleeping ? 'willSleep' : 'willShutdown', reason: kind })
    await saveAll().catch((e) => log('error', `saving before ${kind} failed: ${(e as Error).message}`))
    await new Promise((r) => setTimeout(r, Math.min(GRACE_MS, 200))) // subscribers finish what they were told to
    if (sleeping) {
      await tell({ type: 'sleeping' })
      await bridge.emit('power', { action: 'sleep' }).catch(() => {})
      return
    }
    phase = 'poweredOff'
    log('notice', `${kind} requested`)
    await tell({ type: 'powerOff', restart: kind === 'restart' })
    await bridge.emit('power', { action: kind }).catch(() => {})
  }

  // autosave
  setInterval(() => {
    if (dirty && phase === 'running') void saveAll().catch(() => {})
  }, SAVE_EVERY_MS)

  const verifyPassword = async (pw: unknown) => {
    const hash = await setting<string>('lockHash', '')
    if (!hash) return true
    return typeof pw === 'string' && sha256(`${await setting<string>('lockSalt', '')}:${pw}`) === hash
  }

  return serve(
    tiny,
    'tiny.session',
    {
      // ---- state
      state: async () => ({ phase, locked, safeMode, update, visible, online, uptime: Date.now() - startedAt, restore: await policy() }),
      ...subscription(watchers),
      registerSessionManager: async (_a, m) => {
        await needSystem(tiny, m, 'be the session manager')
        const port = needPort(m, 'pass the port that answers {type: "save-state"} in rights')
        manager = port
        await tiny.watch(port, notifyPort).catch(() => {})
      },

      // ---- session persistence
      save: async (a, m) => {
        await needSystem(tiny, m, 'save the session')
        if (safeMode && a.force !== true) return null // a safe-mode session never overwrites the real one
        await write(a.state ?? null, appStates)
        return { savedAt: Date.now() }
      },
      load: async (_a, m) => {
        await needSystem(tiny, m, 'load the session')
        if (safeMode) return null
        const s = await read()
        return s ? { state: s.state, savedAt: s.savedAt, apps: Object.keys(s.apps) } : null
      },
      clear: async (_a, m) => {
        await needSystem(tiny, m, 'clear the session')
        appStates = {}
        await tiny.unlink(SESSION_FILE).catch(() => {})
      },
      saveAll: async (_a, m) => {
        await needSystem(tiny, m, 'save the session')
        return saveAll()
      },
      /** The session manager says something changed, so the next autosave has work to do. */
      touch: () => void (dirty = true),
      restorePolicy: () => policy(),
      registerApp: async (a, m) => {
        const port = needPort(m, 'pass the port that answers {type: "save-state"} in rights')
        const who = await callerInfo(tiny, m as never)
        const id = who.appId ?? String(a.appId ?? '')
        if (!id) throw fail('EINVAL', 'appId needed')
        if (who.appId && a.appId !== undefined && a.appId !== who.appId) throw fail('EPERM', 'an app registers only for itself')
        apps.set(id, port)
        await tiny.watch(port, notifyPort).catch(() => {})
      },
      saveApp: async (a, m) => {
        const who = await callerInfo(tiny, m as never)
        const id = who.appId ?? String(a.appId ?? '')
        if (!id) throw fail('EINVAL', 'appId needed')
        if (JSON.stringify(a.state ?? null).length > 512 * 1024) throw fail('EFBIG', 'app state is limited to 512 KB')
        appStates[id] = a.state ?? null
        dirty = true
      },
      /** An app asks for the state it left; the system may ask for any app's. */
      appState: async (a, m) => {
        const who = await callerInfo(tiny, m as never)
        const id = who.system ? String(a.appId ?? '') : who.appId!
        if (safeMode) return null
        if (id in appStates) return appStates[id]
        const s = await read()
        if (s) appStates = { ...s.apps, ...appStates }
        return appStates[id] ?? null
      },

      // ---- power and lock
      shutdown: async (_a, m) => (await needSystem(tiny, m, 'shut down'), power('shutdown')),
      restart: async (_a, m) => (await needSystem(tiny, m, 'restart'), power('restart')),
      sleep: async (_a, m) => (await needSystem(tiny, m, 'sleep'), power('sleep')),
      wake: async (_a, m) => {
        await needSystem(tiny, m, 'wake the system')
        if (phase !== 'asleep') return
        phase = 'running'
        await tell({ type: 'didWake' })
        if (await setting('lockOnWake', false)) {
          locked = true
          await tell({ type: 'locked' })
        }
      },
      lockScreen: async (_a, m) => {
        await needSystem(tiny, m, 'lock the screen')
        locked = true
        await tell({ type: 'locked' })
      },
      unlock: async (a, m) => {
        await needSystem(tiny, m, 'unlock the screen')
        if (!locked) return true
        if (!(await verifyPassword(a.password))) throw fail('EACCES', 'wrong password')
        locked = false
        await tell({ type: 'unlocked' })
        return true
      },
      hasPassword: async () => Boolean(await setting('lockHash', '')),
      /** `old` is needed when a password is already set. An empty `password` removes it. Protects casual access only. */
      setPassword: async (a, m) => {
        await needSystem(tiny, m, 'set the password')
        if (!(await verifyPassword(a.old))) throw fail('EACCES', 'wrong password')
        if (!a.password) {
          await tiny.configSet('tiny.session', 'lockHash', '')
          return
        }
        if (typeof a.password !== 'string' || a.password.length > 256) throw fail('EINVAL', 'password must be text up to 256 characters')
        const salt = uuid()
        await tiny.configSet('tiny.session', 'lockSalt', salt)
        await tiny.configSet('tiny.session', 'lockHash', sha256(`${salt}:${a.password}`))
      },

      // ---- startup items
      'startup.list': () => setting<string[]>('startupItems', []),
      'startup.add': async (a, m) => {
        await needSystem(tiny, m, 'change startup items')
        const list = await setting<string[]>('startupItems', [])
        if (typeof a.appId !== 'string' || !a.appId) throw fail('EINVAL', 'appId needed')
        if (!list.includes(a.appId)) await tiny.configSet('tiny.session', 'startupItems', [...list, a.appId])
      },
      'startup.remove': async (a, m) => {
        await needSystem(tiny, m, 'change startup items')
        await tiny.configSet('tiny.session', 'startupItems', (await setting<string[]>('startupItems', [])).filter((x) => x !== a.appId))
      },
      /** Open the startup items (Desktop calls this once the session is restored). Nothing in safe mode. */
      login: async (_a, m) => {
        await needSystem(tiny, m, 'log in')
        if (safeMode) return { opened: [], skipped: 'safeMode' }
        const opened: string[] = []
        for (const id of await setting<string[]>('startupItems', [])) {
          try {
            await tiny.launchOpen(id, { background: true })
            opened.push(id)
          } catch (e) {
            log('error', `startup item ${id} did not open: ${(e as Error).message}`)
          }
        }
        return { opened }
      },

      // ---- updates
      'update.status': () => update,
      'update.apply': async (_a, m) => {
        await needSystem(tiny, m, 'apply an update')
        if (!update.ready) throw fail('ENOENT', 'no update is waiting')
        await saveAll().catch(() => {})
        await bridge.emit('update', { action: 'apply' })
      },
      'update.check': async (_a, m) => {
        await needSystem(tiny, m, 'check for updates')
        await bridge.emit('update', { action: 'check' })
      },
    },
    async (d) => {
      if (d?.type === 'dead-name') {
        if (manager === d.port) manager = null
        for (const [id, port] of apps) if (port === d.port) apps.delete(id)
        return
      }
      const data = d?.type === 'driver' ? d.data : null
      if (!data || bridge.reply(data)) return
      switch (data.event) {
        case 'visibility':
          visible = Boolean(data.visible)
          await tell({ type: 'visibility', visible })
          if (!visible && phase === 'running') void saveAll().catch(() => {}) // the tab may not come back
          break
        case 'pagehide':
          if (phase === 'running') void saveAll().catch(() => {})
          break
        case 'online':
          online = Boolean(data.online)
          await tell({ type: online ? 'online' : 'offline' })
          break
        case 'update':
          update = { ready: Boolean(data.ready), version: data.version }
          await tell({ type: 'updateReady', ...update })
          break
      }
    },
    async (port) => void (notifyPort = port),
  )
}
