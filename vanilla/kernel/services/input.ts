import { Subscribers, fail, hostBridge, needPort, needSystem, serve } from './lib'
import type { Pear } from '../src/runtime'

const KINDS = ['key', 'text', 'composition', 'pointer', 'wheel', 'gesture', 'touch', 'gamepad'] as const
type Kind = (typeof KINDS)[number]
const LAYOUTS = ['us', 'uk', 'de', 'fr', 'es', 'it', 'dvorak', 'colemak']
/** Shortcuts a browser tab keeps for itself, so Desktop should not rely on them (unless keyboard lock is on). */
const RESERVED = ['Cmd+W', 'Cmd+T', 'Cmd+N', 'Cmd+Shift+N', 'Cmd+Shift+T', 'Cmd+Q', 'Cmd+L', 'Cmd+R', 'Cmd+Tab', 'Ctrl+Tab', 'Ctrl+W', 'F5', 'F11']

/**
 * Layout translation: the `key` a physical key (its `code`) produces in a layout other than the one the host has.
 * Letters come as rows of the physical QWERTY positions; other keys as `[plain, shifted]`. `us`, `es` and `it`
 * pass through (their letters sit where QWERTY has them).
 */
const ROWS = [
  ['KeyQ', 'KeyW', 'KeyE', 'KeyR', 'KeyT', 'KeyY', 'KeyU', 'KeyI', 'KeyO', 'KeyP', 'BracketLeft', 'BracketRight'],
  ['KeyA', 'KeyS', 'KeyD', 'KeyF', 'KeyG', 'KeyH', 'KeyJ', 'KeyK', 'KeyL', 'Semicolon', 'Quote'],
  ['KeyZ', 'KeyX', 'KeyC', 'KeyV', 'KeyB', 'KeyN', 'KeyM', 'Comma', 'Period', 'Slash'],
]
const fromRows = (rows: [string, string, string]): Record<string, [string, string]> => {
  const out: Record<string, [string, string]> = {}
  rows.forEach((chars, r) => [...chars].forEach((c, i) => {
    const code = ROWS[r]![i]
    if (code) out[code] = [c, c.toUpperCase()]
  }))
  return out
}
const PUNCT_SHIFT: Record<string, string> = { "'": '"', ',': '<', '.': '>', ';': ':', '/': '?', '[': '{', ']': '}', '-': '_', '=': '+' }
const shifted = (t: Record<string, [string, string]>) => {
  for (const v of Object.values(t)) v[1] = PUNCT_SHIFT[v[0]] ?? v[0].toUpperCase()
  return t
}
const TRANSLATE: Record<string, Record<string, [string, string]>> = {
  dvorak: shifted({ ...fromRows(["',.pyfgcrl[]", 'aoeuidhtns-', ';qjkxbmwvz']), Minus: ['[', '{'], Equal: [']', '}'] }),
  colemak: shifted(fromRows(['qwfpgjluy;[]', "arstdhneio'", 'zxcvbkm,./'])),
  de: { ...fromRows(['qwertzuiopü+', 'asdfghjklöä', 'yxcvbnm,.-']), Digit2: ['2', '"'], Digit3: ['3', '§'], Digit6: ['6', '&'], Digit7: ['7', '/'], Digit8: ['8', '('], Digit9: ['9', ')'], Digit0: ['0', '='] },
  fr: { ...fromRows(['azertyuiop^$', 'qsdfghjklmù', 'wxcvbn,;:!']), Digit1: ['&', '1'], Digit2: ['é', '2'], Digit3: ['"', '3'], Digit4: ["'", '4'], Digit5: ['(', '5'], Digit6: ['-', '6'], Digit7: ['è', '7'], Digit8: ['_', '8'], Digit9: ['ç', '9'], Digit0: ['à', '0'] },
  uk: { Digit2: ['2', '"'], Digit3: ['3', '£'], Quote: ["'", '@'], Backquote: ['`', '¬'], Backslash: ['#', '~'], IntlBackslash: ['\\', '|'] },
}

interface Sub {
  port: number
  kinds: Set<Kind>
}
interface Grab {
  port: number
  kind: Kind
  exclusive: boolean
}

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const str = (v: unknown, max = 64) => (typeof v === 'string' ? v.slice(0, max) : '')
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => (list.includes(v as T) ? (v as T) : d)

/**
 * `tiny.input`: the stream of host input events, normalised (`contracts/input.md`). The page's driver pushes raw
 * events; this service maps modifiers (Cmd), drops what it does not know, and delivers `{type: 'input', ...}` to
 * subscribers and grabbers. Only the system (Desktop, root services) may subscribe or grab: apps get input from
 * Desktop, which knows which window has the focus.
 */
export default async (tiny: Pear) => {
  const subs = new Subscribers<Sub>(tiny, 16)
  const grabs = new Map<Kind, Grab[]>()
  const host = hostBridge(tiny, 'input')
  let platform = String((navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '')
  let keyboardLock = false
  let delivered = 0
  let dropped = 0
  let cmdSetting = String(await tiny.configGet('tiny.input', 'cmdMapping', 'auto'))
  let layout = String(await tiny.configGet('tiny.input', 'layout', 'us'))
  /** Events are handled one at a time, so they reach subscribers in the order the page saw them. */
  let queue: Promise<unknown> = Promise.resolve()

  const isMac = () => /mac|iphone|ipad/i.test(platform)
  const cmdSource = async (): Promise<'meta' | 'ctrl'> => {
    const setting = cmdSetting
    return setting === 'meta' ? 'meta' : setting === 'ctrl' ? 'ctrl' : isMac() ? 'meta' : 'ctrl'
  }
  const mods = (raw: any, source: 'meta' | 'ctrl') => ({
    cmd: Boolean(source === 'meta' ? raw.metaKey : raw.ctrlKey),
    ctrl: source === 'meta' ? Boolean(raw.ctrlKey) : false,
    opt: Boolean(raw.altKey),
    shift: Boolean(raw.shiftKey),
    fn: Boolean(raw.fnKey),
  })

  const normalize = async (raw: any): Promise<Record<string, unknown> | null> => {
    const kind = raw?.kind as Kind
    if (!KINDS.includes(kind)) return null
    const base = { type: 'input' as const, kind, time: num(raw.time, performance.now()) }
    const source = await cmdSource()
    switch (kind) {
      case 'key': {
        let { code, key } = { code: str(raw.code), key: str(raw.key) }
        if (source === 'ctrl') {
          // Ctrl is the Cmd key on this host, so the key itself is reported as Cmd too
          if (code === 'ControlLeft') code = 'MetaLeft'
          else if (code === 'ControlRight') code = 'MetaRight'
          if (key === 'Control') key = 'Meta'
        }
        const mapped = TRANSLATE[layout]?.[code]
        if (mapped && !(raw.ctrlKey && source === 'meta') && key.length <= 2) key = raw.shiftKey ? mapped[1] : mapped[0]
        return { ...base, phase: oneOf(raw.phase, ['down', 'up', 'repeat'], 'down'), code, key, mods: mods(raw, source) }
      }
      case 'text':
        return { ...base, text: str(raw.text, 4096) }
      case 'composition':
        return { ...base, phase: oneOf(raw.phase, ['start', 'update', 'end'], 'update'), text: str(raw.text, 4096), start: num(raw.start), end: num(raw.end) }
      case 'pointer':
        return {
          ...base, phase: oneOf(raw.phase, ['move', 'down', 'up', 'enter', 'leave', 'cancel'], 'move'), x: num(raw.x), y: num(raw.y),
          button: num(raw.button, -1), buttons: num(raw.buttons), pressure: num(raw.pressure), pointerType: oneOf(raw.pointerType, ['mouse', 'pen', 'touch'], 'mouse'),
          pointerId: num(raw.pointerId), mods: mods(raw, source),
        }
      case 'wheel':
        return { ...base, dx: num(raw.dx), dy: num(raw.dy), mode: oneOf(raw.mode, ['pixel', 'line', 'page'], 'pixel'), precise: Boolean(raw.precise), x: num(raw.x), y: num(raw.y), mods: mods(raw, source) }
      case 'gesture':
        return {
          ...base, phase: oneOf(raw.phase, ['begin', 'change', 'end'], 'change'), gesture: oneOf(raw.gesture, ['pinch', 'rotate', 'swipe'], 'pinch'),
          scale: num(raw.scale, 1), rotation: num(raw.rotation), dx: num(raw.dx), dy: num(raw.dy), x: num(raw.x), y: num(raw.y),
        }
      case 'touch':
        return {
          ...base, phase: oneOf(raw.phase, ['start', 'move', 'end', 'cancel'], 'move'),
          points: (Array.isArray(raw.points) ? raw.points.slice(0, 16) : []).map((p: any) => ({ id: num(p?.id), x: num(p?.x), y: num(p?.y), force: num(p?.force) })),
        }
      case 'gamepad':
        return {
          ...base, phase: oneOf(raw.phase, ['connect', 'disconnect', 'state'], 'state'), index: num(raw.index), id: str(raw.id, 128),
          buttons: (Array.isArray(raw.buttons) ? raw.buttons.slice(0, 32) : []).map((b: unknown) => num(b)), axes: (Array.isArray(raw.axes) ? raw.axes.slice(0, 16) : []).map((a: unknown) => num(a)),
        }
    }
  }

  const route = async (event: Record<string, unknown>) => {
    const kind = event.kind as Kind
    const held = grabs.get(kind) ?? []
    const exclusive = held.find((g) => g.exclusive)
    const targets = new Set<number>()
    if (exclusive) targets.add(exclusive.port)
    else {
      for (const g of held) targets.add(g.port)
      for (const s of subs.items) if (s.kinds.has(kind)) targets.add(s.port)
    }
    for (const port of targets) {
      await tiny.send(port, event).then(
        () => void delivered++,
        (e: { code?: string }) => {
          if (e?.code === 'EPIPE' || e?.code === 'EACCES') {
            subs.removePort(port)
            for (const [k, list] of grabs) grabs.set(k, list.filter((g) => g.port !== port))
          } else dropped++ // a full queue loses the event instead of stalling every other subscriber
        },
      )
    }
  }

  const kindsOf = (v: unknown): Kind[] => {
    const list = v === undefined ? [...KINDS] : v
    if (!Array.isArray(list) || !list.length || list.some((k) => !KINDS.includes(k))) throw fail('EINVAL', `kinds are ${KINDS.join(', ')}`)
    return list
  }
  const kindOf = (v: unknown): Kind => {
    if (!KINDS.includes(v as Kind)) throw fail('EINVAL', `kind must be one of ${KINDS.join(', ')}`)
    return v as Kind
  }

  return serve(
    tiny,
    'tiny.input',
    {
      subscribe: async (a, m) => {
        await needSystem(tiny, m, 'listen to input events')
        const port = needPort(m)
        const kinds = new Set(kindsOf(a.kinds)) // checked first: a bad request must not drop the subscription it would replace
        subs.removePort(port)
        subs.add({ port, kinds })
      },
      unsubscribe: (_a, m) => subs.removePort(m.rights[0] as number),
      grab: async (a, m) => {
        await needSystem(tiny, m, 'grab input')
        const port = needPort(m)
        const kind = kindOf(a.kind)
        const list = (grabs.get(kind) ?? []).filter((g) => g.port !== port)
        const exclusive = Boolean(a.exclusive)
        if (exclusive && list.some((g) => g.exclusive)) throw fail('EBUSY', `${kind} events are already grabbed exclusively`)
        list.push({ port, kind, exclusive })
        grabs.set(kind, list)
      },
      release: async (a, m) => {
        await needSystem(tiny, m, 'release a grab')
        const port = m.rights[0]
        for (const kind of a.kind === undefined ? KINDS : [kindOf(a.kind)]) {
          grabs.set(kind, (grabs.get(kind) ?? []).filter((g) => g.port !== port))
        }
      },
      layouts: async () => ({ layouts: LAYOUTS, current: String(await tiny.configGet('tiny.input', 'layout', 'us')) }),
      setKeyboardLayout: async (a, m) => {
        await needSystem(tiny, m, 'change the keyboard layout')
        if (!LAYOUTS.includes(a.id)) throw fail('EINVAL', `unknown layout ${String(a.id)}`)
        await tiny.configSet('tiny.input', 'layout', a.id)
        layout = a.id
        await subs.send({ type: 'layout', id: a.id }, () => true)
      },
      /** Keep browser shortcuts (Cmd+W, Cmd+Tab...) for Desktop. Needs fullscreen in some browsers. `keys` limits it to those codes. */
      keyboardLock: async (a, m) => {
        await needSystem(tiny, m, 'lock the keyboard')
        const keys = Array.isArray(a.keys) ? a.keys.map((k: unknown) => str(k, 32)) : undefined
        await host.call('keyboardLock', { keys })
        keyboardLock = true
      },
      keyboardUnlock: async (_a, m) => {
        await needSystem(tiny, m, 'unlock the keyboard')
        await host.call('keyboardUnlock')
        keyboardLock = false
      },
      reserved: () => ({ shortcuts: RESERVED, keyboardLock }),
      pointerLock: async (a, m) => {
        await needSystem(tiny, m, 'lock the pointer')
        return host.call('pointerLock', { on: Boolean(a.on) })
      },
      haptic: (a) => {
        const p = a.pattern
        const ok = (x: unknown) => typeof x === 'number' && x >= 0 && x <= 5000
        if (!(ok(p) || (Array.isArray(p) && p.length <= 20 && p.every(ok)))) throw fail('EINVAL', 'pattern is a number or a short list of durations in ms')
        return host.emit('haptic', { pattern: p })
      },
      announce: (a) => {
        if (typeof a.text !== 'string' || !a.text || a.text.length > 500) throw fail('EINVAL', 'text must be 1-500 characters')
        return host.emit('announce', { text: a.text, priority: a.priority === 'assertive' ? 'assertive' : 'polite' })
      },
      state: async () => ({
        platform, cmd: await cmdSource(), keyboardLock, subscribers: subs.items.size,
        grabs: Object.fromEntries([...grabs].filter(([, l]) => l.length).map(([k, l]) => [k, l.map((g) => (g.exclusive ? 'exclusive' : 'shared'))])),
        delivered, dropped,
      }),
    },
    (d) => {
      // everything the page and the settings say is handled in order, so a change applies to the events after it only
      queue = queue.then(async () => {
        if (d?.type === 'config-changed' && d.domain === 'tiny.input' && d.key === 'cmdMapping') {
          cmdSetting = String(d.value ?? 'auto')
          return
        }
        if (d?.type === 'config-changed' && d.domain === 'tiny.input' && d.key === 'layout') {
          layout = String(d.value ?? 'us')
          return
        }
        const data = d?.type === 'driver' ? d.data : null
        if (!data || host.reply(data)) return
        if (data.event === 'host-info') {
          if (typeof data.platform === 'string') platform = data.platform.slice(0, 64)
          keyboardLock = Boolean(data.keyboardLock)
        } else if (data.event === 'input') {
          const event = await normalize(data.input)
          if (event) await route(event)
        }
      }).catch(() => {})
    },
    async (port) => void (await tiny.configWatch('tiny.input', null, port)),
  )
}
