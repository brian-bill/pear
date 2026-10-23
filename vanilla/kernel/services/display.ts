import { Owners, Subscribers, callerInfo, fail, hostBridge, needCapability, needSystem, serve, subscription } from './lib'
import type { Pear } from '../src/runtime'

const KINDS = ['2d', 'webgl', 'bitmap'] as const
const ROLES = ['window', 'sheet', 'popup', 'menu', 'tooltip', 'desktop', 'panel']
const CURSORS = [
  'default', 'pointer', 'text', 'crosshair', 'move', 'grab', 'grabbing', 'wait', 'progress', 'help', 'not-allowed', 'copy', 'alias', 'none',
  'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize', 'col-resize', 'row-resize', 'zoom-in', 'zoom-out',
]
const MAX_SURFACES_PER_PROCESS = 32
const MAX_FRAME_BYTES = 64 * 1024 * 1024

interface Display {
  id: number
  width: number
  height: number
  scale: number
  refreshRate: number
  colorSpace: 'srgb' | 'display-p3'
  fullscreen: boolean
}
interface Surface {
  id: number
  owner: number
  appId: string | null
  width: number
  height: number
  scale: number
  kind: (typeof KINDS)[number]
  title: string
  role: string
  opaque: boolean
  frame: number
}

const dim = (v: unknown, what: string, max: number) => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max) throw fail('EINVAL', `${what} must be a whole number from 1 to ${max}`)
  return v
}

/**
 * `tiny.display`: screens and drawing surfaces (`contracts/display.md`). Desktop's compositor subscribes and gets
 * `{type: 'commit', surface, frame, damage, buffer?}` as apps commit. A `bitmap` surface commits RGBA pixels
 * (`width * height * 4` bytes, passed by transfer: there is no shared memory); `2d` and `webgl` surfaces hand their
 * `OffscreenCanvas` over with `attach` and the compositor reads it directly.
 */
export default async (tiny: Pear) => {
  let displays: Display[] = [{ id: 0, width: 1280, height: 800, scale: 1, refreshRate: 60, colorSpace: 'srgb', fullscreen: false }]
  let gpu = { vendor: '', renderer: '', maxTextureSize: 4096, webgl2: false, software: false }
  const surfaces = new Map<number, Surface>()
  const watchers = new Subscribers<{ port: number }>(tiny)
  const host = hostBridge(tiny, 'display')
  let nextId = 1
  let cursor: { shape: string; owner: number } = { shape: 'default', owner: 0 }
  const owners = new Owners(tiny, async (pid) => {
    for (const s of [...surfaces.values()]) if (s.owner === pid) await destroy(s)
  })

  const destroy = async (s: Surface) => {
    surfaces.delete(s.id)
    await watchers.send({ type: 'surface-destroyed', surface: s.id })
  }
  const mine = async (id: unknown, m: { from: number }): Promise<Surface> => {
    const s = surfaces.get(id as number)
    if (!s) throw fail('ENOENT', 'no such surface')
    if (s.owner !== m.from && !(await callerInfo(tiny, m as never)).system) throw fail('EPERM', 'not your surface')
    return s
  }
  const view = (s: Surface) => ({ id: s.id, owner: s.owner, appId: s.appId, width: s.width, height: s.height, scale: s.scale, kind: s.kind, title: s.title, role: s.role, opaque: s.opaque, frame: s.frame })
  const checkSize = (w: number, h: number) => {
    if (w > gpu.maxTextureSize || h > gpu.maxTextureSize) throw fail('EINVAL', `the largest surface is ${gpu.maxTextureSize} pixels on a side`)
  }

  return serve(
    tiny,
    'tiny.display',
    {
      list: () => displays,
      gpu: () => gpu,
      root: () => {
        const d = displays[0]!
        return { display: d.id, width: d.width, height: d.height, scale: d.scale }
      },
      ...subscription(watchers),
      requestFullscreen: async (a, m) => {
        await needSystem(tiny, m, 'switch to full screen')
        await host.call('fullscreen', { on: true, display: a.display ?? 0 })
      },
      exitFullscreen: async (_a, m) => {
        await needSystem(tiny, m, 'leave full screen')
        await host.call('fullscreen', { on: false })
      },
      capture: async (a, m) => {
        await needCapability(tiny, m, 'display.capture', 'capture the screen')
        const r = a.region
        if (r !== undefined && !(r && ['x', 'y', 'width', 'height'].every((k) => typeof r[k] === 'number'))) throw fail('EINVAL', 'region is {x, y, width, height}')
        return host.call('capture', { region: r ?? null }, 10_000)
      },
      fonts: async () => {
        const names = await tiny.readdir('/System/Library/Fonts').catch(() => [])
        return names.map((e) => e.name).sort()
      },

      // ---- surfaces
      create: async (a, m) => {
        const kind = (a.kind ?? 'bitmap') as Surface['kind']
        if (!KINDS.includes(kind)) throw fail('EINVAL', `kind is one of ${KINDS.join(', ')}`)
        const width = dim(a.width, 'width', 1 << 16)
        const height = dim(a.height, 'height', 1 << 16)
        checkSize(width, height)
        const scale = typeof a.scale === 'number' && a.scale >= 1 && a.scale <= 8 ? a.scale : (displays[0]?.scale ?? 1)
        if ([...surfaces.values()].filter((s) => s.owner === m.from).length >= MAX_SURFACES_PER_PROCESS) throw fail('EMFILE', 'too many surfaces')
        const info = m.from === 1 ? null : await tiny.info(m.from)
        const s: Surface = { id: nextId++, owner: m.from, appId: info?.appId ?? null, width, height, scale, kind, title: '', role: 'window', opaque: true, frame: 0 }
        surfaces.set(s.id, s)
        owners.add(m.from)
        await watchers.send({ type: 'surface-created', surface: view(s) })
        return s.id
      },
      resize: async (a, m) => {
        const s = await mine(a.id, m)
        const width = dim(a.width, 'width', 1 << 16)
        const height = dim(a.height, 'height', 1 << 16)
        checkSize(width, height)
        s.width = width
        s.height = height
        if (typeof a.scale === 'number' && a.scale >= 1 && a.scale <= 8) s.scale = a.scale
        await watchers.send({ type: 'surface-resized', surface: view(s) })
      },
      destroy: async (a, m) => destroy(await mine(a.id, m)),
      setMeta: async (a, m) => {
        const s = await mine(a.id, m)
        if (a.title !== undefined) {
          if (typeof a.title !== 'string' || a.title.length > 500) throw fail('EINVAL', 'title must be text up to 500 characters')
          s.title = a.title
        }
        if (a.role !== undefined) {
          if (!ROLES.includes(a.role)) throw fail('EINVAL', `role is one of ${ROLES.join(', ')}`)
          s.role = a.role
        }
        if (a.opaque !== undefined) s.opaque = Boolean(a.opaque)
        await watchers.send({ type: 'surface-meta', surface: view(s) })
      },
      commit: async (a, m) => {
        const s = await mine(a.id, m)
        let buffer: Uint8Array | undefined
        if (a.buffer !== undefined) {
          buffer = a.buffer instanceof ArrayBuffer ? new Uint8Array(a.buffer) : a.buffer
          if (!(buffer instanceof Uint8Array)) throw fail('EINVAL', 'buffer must be RGBA bytes')
          if (s.kind !== 'bitmap') throw fail('EINVAL', 'only bitmap surfaces commit pixels')
          const want = s.width * s.height * 4
          if (buffer.byteLength !== want || want > MAX_FRAME_BYTES) throw fail('EINVAL', `a ${s.width}x${s.height} frame is ${want} bytes`)
        }
        const damage = a.damage === undefined ? null : a.damage
        if (damage !== null) {
          if (!Array.isArray(damage) || damage.length > 64 || damage.some((r: any) => !['x', 'y', 'width', 'height'].every((k) => typeof r?.[k] === 'number' && r[k] >= 0))) {
            throw fail('EINVAL', 'damage is a short list of {x, y, width, height}')
          }
        }
        s.frame++
        await watchers.send({ type: 'commit', surface: s.id, frame: s.frame, damage, buffer: buffer ?? null })
        return s.frame
      },
      attach: async (a, m) => {
        const s = await mine(a.id, m)
        if (s.kind === 'bitmap') throw fail('EINVAL', 'bitmap surfaces commit pixels instead')
        if (typeof OffscreenCanvas !== 'undefined' && !(a.canvas instanceof OffscreenCanvas)) throw fail('EINVAL', 'attach an OffscreenCanvas')
        await watchers.send({ type: 'attach', surface: s.id, canvas: a.canvas })
      },
      surfaces: async (_a, m) => {
        const c = await callerInfo(tiny, m)
        return [...surfaces.values()].filter((s) => c.system || s.owner === m.from).map(view)
      },
      setCursor: async (a, m) => {
        const shape = String(a.shape ?? 'default')
        if (!CURSORS.includes(shape)) throw fail('EINVAL', `cursor is one of ${CURSORS.join(', ')}`)
        cursor = { shape, owner: m.from }
        await watchers.send({ type: 'cursor', shape, hotspot: a.hotspot ?? null, image: a.image ?? null })
        void host.emit('cursor', { shape }).catch(() => {})
      },
      cursor: () => cursor.shape,
    },
    async (d) => {
      const data = d?.type === 'driver' ? d.data : null
      if (!data || host.reply(data)) return
      switch (data.event) {
        case 'screens': {
          const list = (Array.isArray(data.displays) ? data.displays : []).slice(0, 8)
          const next: Display[] = list.map((x: any, i: number) => ({
            id: i, width: Math.max(1, Math.round(Number(x.width) || 1)), height: Math.max(1, Math.round(Number(x.height) || 1)), scale: Number(x.scale) || 1,
            refreshRate: Number(x.refreshRate) || 60, colorSpace: x.colorSpace === 'display-p3' ? 'display-p3' : 'srgb', fullscreen: Boolean(x.fullscreen),
          }))
          if (!next.length) return
          const first = displays[0]!
          displays = next
          const now = next[0]!
          const kind = now.scale !== first.scale ? 'scale' : now.fullscreen !== first.fullscreen ? 'fullscreen' : 'resize'
          return watchers.send({ type: 'display-changed', change: kind, displays })
        }
        case 'gpu':
          gpu = { ...gpu, ...Object.fromEntries(Object.entries(data.gpu ?? {}).filter(([k]) => k in gpu)) } as typeof gpu
          return
        case 'contextlost':
        case 'contextrestored':
          return watchers.send({ type: data.event })
      }
    },
  )
}
