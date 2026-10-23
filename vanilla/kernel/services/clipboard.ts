import { Owners, Subscribers, callerInfo, fail, hostBridge, needCapability, needPort, needSystem, serve } from './lib'
import type { Pear } from '../src/runtime'

/** UTI-style names and their MIME types. */
const ALIASES: Record<string, string> = {
  'public.utf8-plain-text': 'text/plain',
  'public.plain-text': 'text/plain',
  'public.text': 'text/plain',
  'public.html': 'text/html',
  'public.png': 'image/png',
  'public.jpeg': 'image/jpeg',
  'public.url': 'text/uri-list',
  'public.file-url': 'text/uri-list',
  'public.json': 'application/json',
}
const canonical = (t: string) => ALIASES[t] ?? t.toLowerCase()

const BOARDS = new Set(['general', 'drag', 'find'])
/** Data bigger than this is parked in a temp file and read back when somebody pastes. */
const SPILL_BYTES = 256 * 1024
const MAX_ITEM_BYTES = 32 * 1024 * 1024
const MAX_ITEMS = 32
const SPILL_DIR = '/tmp/.pasteboard'
const HOST_TYPES = new Set(['text/plain', 'text/html'])
const OPS = new Set(['copy', 'move', 'link'])

interface Item {
  type: string
  /** The data, or where it was parked, or (lazy) nothing until somebody asks. */
  data?: string | Uint8Array
  file?: string
  size: number
  lazy?: boolean
}
interface Board {
  items: Item[]
  count: number
  owner: number | null
  provider: number | null
  /** Where the content came from: an app (`pid`) or the host clipboard. */
  source: 'app' | 'host' | 'none'
}
interface DragSession {
  id: number
  owner: number
  items: Item[]
  allowed: string[]
  image: Uint8Array | null
  position: { x: number; y: number } | null
  over: string | null
}

const sizeOf = (data: unknown): number =>
  typeof data === 'string' ? data.length * 2 : data instanceof Uint8Array ? data.byteLength : data instanceof ArrayBuffer ? data.byteLength : -1

/**
 * `tiny.clipboard`: the system pasteboards (`general`, `drag`, `find`) and drag and drop (`contracts/clipboard.md`).
 * Items are `{type, data}`, one per representation. The general pasteboard needs the `clipboard` permission and is
 * mirrored to the host clipboard by the page's driver when the page allows it.
 */
export default async (tiny: Pear) => {
  const boards = new Map<string, Board>(
    [...BOARDS].map((n) => [n, { items: [], count: 0, owner: null, provider: null, source: 'none' } as Board]),
  )
  const watchers = new Subscribers<{ port: number; board: string | null }>(tiny)
  const dragWatchers = new Subscribers<{ port: number }>(tiny)
  const host = hostBridge(tiny, 'clipboard')
  let drag: DragSession | null = null
  let spillId = 0
  const owners = new Owners(tiny, async (pid) => {
    if (drag?.owner === pid) await endDrag('cancel')
  })

  const board = (name: unknown): Board => {
    const b = boards.get(String(name ?? 'general'))
    if (!b) throw fail('EINVAL', `no pasteboard called ${String(name)}`)
    return b
  }
  const nameOf = (name: unknown) => String(name ?? 'general')

  const forget = async (items: Item[]) => {
    for (const i of items) if (i.file) await tiny.unlink(i.file).catch(() => {})
  }
  const store = async (raw: any): Promise<Item> => {
    if (!raw || typeof raw.type !== 'string' || !raw.type || raw.type.length > 255) throw fail('EINVAL', 'an item needs a type')
    const type = canonical(raw.type)
    if (raw.lazy) return { type, size: 0, lazy: true }
    const data = raw.data instanceof ArrayBuffer ? new Uint8Array(raw.data) : raw.data
    const size = sizeOf(data)
    if (size < 0) throw fail('EINVAL', `data of ${type} must be text or bytes`)
    if (size > MAX_ITEM_BYTES) throw fail('E2BIG', `${type} is too large for the pasteboard`)
    if (size > SPILL_BYTES) {
      await tiny.mkdir(SPILL_DIR, { recursive: true }).catch(() => {})
      const file = `${SPILL_DIR}/${++spillId}`
      await tiny.writeFile(file, typeof data === 'string' ? new TextEncoder().encode(data) : data)
      return { type, file, size, data: typeof data === 'string' ? '' : undefined }
    }
    return { type, data, size }
  }
  const load = async (b: Board, i: Item): Promise<unknown> => {
    if (i.lazy) {
      if (b.provider === null) throw fail('ENOENT', `nothing provides ${i.type} any more`)
      const answer = await tiny.request(b.provider, { type: 'provide', mime: i.type }, { timeout: 2000 }).catch(() => null)
      const data = (answer?.data as { data?: unknown } | null)?.data
      if (sizeOf(data) < 0) throw fail('ENOENT', `the owner could not provide ${i.type}`)
      return data instanceof ArrayBuffer ? new Uint8Array(data) : data
    }
    if (i.file) {
      const bytes = await tiny.readFile(i.file)
      return typeof i.data === 'string' ? new TextDecoder().decode(bytes) : bytes
    }
    return i.data
  }
  const describe = (b: Board) => b.items.map((i) => ({ type: i.type, size: i.size, lazy: Boolean(i.lazy) }))
  const changed = async (name: string) => {
    const b = boards.get(name)!
    await watchers.send({ type: 'changed', board: name, changeCount: b.count, types: b.items.map((i) => i.type), source: b.source }, (s) => s.board === null || s.board === name)
  }
  const access = async (m: any, name: string, what: string) => {
    if (name === 'general') await needCapability(tiny, m, 'clipboard', what)
  }
  const replace = async (name: string, items: Item[], owner: number | null, provider: number | null, source: Board['source']) => {
    const b = boards.get(name)!
    await forget(b.items)
    b.items = items
    b.owner = owner
    b.provider = provider
    b.source = source
    b.count++
    if (owner !== null) owners.add(owner)
    await changed(name)
  }

  const endDrag = async (event: 'drop' | 'cancel', extra: Record<string, unknown> = {}) => {
    const d = drag
    if (!d) return
    drag = null
    await dragWatchers.send({ type: event, session: d.id, ...extra })
  }

  return serve(
    tiny,
    'tiny.clipboard',
    {
      write: async (a, m) => {
        const name = nameOf(a.board)
        board(name)
        await access(m, name, 'put things on the clipboard')
        if (!Array.isArray(a.items) || a.items.length > MAX_ITEMS) throw fail('EINVAL', `items must be a list of up to ${MAX_ITEMS}`)
        const items: Item[] = []
        try {
          for (const raw of a.items) items.push(await store(raw))
        } catch (e) {
          await forget(items)
          throw e
        }
        if (new Set(items.map((i) => i.type)).size !== items.length) {
          await forget(items)
          throw fail('EINVAL', 'each type may appear once')
        }
        if (items.some((i) => i.lazy) && m.rights[0] === undefined) throw fail('EINVAL', 'lazy items need a provider port in rights')
        await replace(name, items, m.from, items.some((i) => i.lazy) ? (m.rights[0] ?? null) : null, 'app')
        if (name === 'general') {
          // text and HTML go to the host clipboard; the page decides whether it may
          const send = items.filter((i) => HOST_TYPES.has(i.type) && !i.lazy)
          const out: Array<{ type: string; data: unknown }> = []
          for (const i of send) out.push({ type: i.type, data: await load(board(name), i) })
          void host.emit('write', { items: out }).catch(() => {})
        }
        return boards.get(name)!.count
      },
      read: async (a, m) => {
        const name = nameOf(a.board)
        const b = board(name)
        await access(m, name, 'read the clipboard')
        const want = Array.isArray(a.types) ? a.types.map((t: unknown) => canonical(String(t))) : null
        const out: Array<{ type: string; data: unknown }> = []
        for (const i of b.items) {
          if (want && !want.includes(i.type)) continue
          try {
            out.push({ type: i.type, data: await load(b, i) })
          } catch (e) {
            if (!i.lazy) throw e // a provider that went away only loses its own item
          }
        }
        return { items: out, changeCount: b.count }
      },
      types: async (a, m) => {
        const name = nameOf(a.board)
        await access(m, name, 'see what is on the clipboard')
        return describe(board(name))
      },
      clear: async (a, m) => {
        const name = nameOf(a.board)
        board(name)
        await access(m, name, 'clear the clipboard')
        await replace(name, [], null, null, 'none')
        return boards.get(name)!.count
      },
      changeCount: (a) => board(a.board).count,
      subscribe: (a, m) => {
        const port = needPort(m)
        const name = a.board === undefined ? null : nameOf(a.board)
        if (name !== null) board(name)
        watchers.add({ port, board: name })
      },
      unsubscribe: (_a, m) => watchers.removePort(m.rights[0] as number),

      // ---- drag and drop
      dragBegin: async (a, m) => {
        if (drag) throw fail('EBUSY', 'a drag is already under way')
        if (!Array.isArray(a.items) || !a.items.length || a.items.length > MAX_ITEMS) throw fail('EINVAL', 'items must be a short, non-empty list')
        const allowed: string[] = a.allowedOps ?? ['copy', 'move', 'link']
        if (!Array.isArray(allowed) || !allowed.length || allowed.some((o) => !OPS.has(o))) throw fail('EINVAL', 'allowedOps are copy, move, link')
        const image = a.image === undefined ? null : a.image instanceof ArrayBuffer ? new Uint8Array(a.image) : a.image
        if (image !== null && !(image instanceof Uint8Array)) throw fail('EINVAL', 'the drag image must be bitmap bytes, not DOM')
        const items: Item[] = []
        for (const raw of a.items) items.push(await store(raw))
        drag = { id: Date.now() % 1_000_000_000, owner: m.from, items, allowed, image, position: null, over: null }
        owners.add(m.from)
        // the drag items are also on the drag pasteboard, so targets can read them with `read({board: 'drag'})`
        await replace('drag', items.map((i) => ({ ...i })), m.from, null, 'app')
        await dragWatchers.send({ type: 'begin', session: drag.id, types: items.map((i) => i.type), allowedOps: allowed, image })
        return drag.id
      },
      dragUpdate: async (a, m) => {
        const d = drag
        if (!d || d.id !== a.session) throw fail('ENOENT', 'no such drag')
        if (d.owner !== m.from && m.from !== 1) throw fail('EPERM', 'not your drag')
        const pos = a.position
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') throw fail('EINVAL', 'position is {x, y}')
        const target = a.target === undefined ? null : String(a.target)
        if (d.over !== target) {
          if (d.over !== null) await dragWatchers.send({ type: 'leave', session: d.id, target: d.over })
          if (target !== null) await dragWatchers.send({ type: 'enter', session: d.id, target, position: pos })
          d.over = target
        }
        d.position = pos
        await dragWatchers.send({ type: 'over', session: d.id, target, position: pos })
      },
      dragDrop: async (a, m) => {
        const d = drag
        if (!d || d.id !== a.session) throw fail('ENOENT', 'no such drag')
        if (d.owner !== m.from && m.from !== 1) throw fail('EPERM', 'not your drag')
        const op = String(a.operation ?? d.allowed[0])
        if (!d.allowed.includes(op)) throw fail('EINVAL', `${op} is not allowed for this drag (${d.allowed.join(', ')})`)
        await endDrag('drop', { target: a.target ?? d.over, operation: op, position: a.position ?? d.position })
        return op
      },
      dragCancel: async (a, m) => {
        const d = drag
        if (!d || d.id !== a.session) return false
        if (d.owner !== m.from && m.from !== 1) throw fail('EPERM', 'not your drag')
        await endDrag('cancel')
        return true
      },
      dragSubscribe: async (_a, m) => {
        await needSystem(tiny, m, 'watch drags')
        const port = needPort(m)
        dragWatchers.add({ port })
      },
      dragUnsubscribe: (_a, m) => dragWatchers.removePort(m.rights[0] as number),
      dragInfo: async (_a, m) => {
        const c = await callerInfo(tiny, m)
        return drag ? { session: drag.id, types: drag.items.map((i) => i.type), allowedOps: drag.allowed, mine: drag.owner === m.from || c.system } : null
      },
    },
    async (d) => {
      const data = d?.type === 'driver' ? d.data : null
      if (!data || host.reply(data)) return
      if (data.event === 'host-write') {
        // the user copied or pasted on the host: the host clipboard becomes the general pasteboard
        const items: Item[] = []
        for (const raw of Array.isArray(data.items) ? data.items.slice(0, MAX_ITEMS) : []) {
          try {
            items.push(await store(raw))
          } catch {
            // skip what cannot be stored
          }
        }
        if (items.length) await replace('general', items, null, null, 'host')
      } else if (data.event === 'host-drop') {
        // files or text dropped on the tab from the host: Desktop imports them (see import-export)
        await dragWatchers.send({ type: 'host-drop', files: data.files ?? [], items: data.items ?? [], position: data.position ?? null })
      }
    },
  )
}
