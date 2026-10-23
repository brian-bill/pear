import { Owners, Subscribers, fail, hostBridge, needCapability, needPort, needSystem, serve, subscription } from './lib'
import type { Pear } from '../src/runtime'

const KINDS = ['playback', 'media', 'alert', 'voice']
const SOUND_EXT = ['wav', 'mp3', 'ogg', 'm4a', 'aac', 'caf', 'flac']
const MAX_STREAMS_PER_PROCESS = 8
const MAX_CHUNK_BYTES = 1 << 20
/** A stream that wrote within this long ago counts as playing. */
const PLAYING_MS = 500

interface Stream {
  id: number
  owner: number
  appId: string | null
  sampleRate: number
  channels: number
  kind: string
  lastWrite: number
  audible: boolean
  frames: number
}
interface Mic {
  id: number
  owner: number
  port: number
}

const clamp01 = (v: unknown, what: string) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw fail('EINVAL', `${what} must be a number from 0 to 1`)
  return Math.min(1, Math.max(0, v))
}

/**
 * `tiny.audio`: output mixing and microphones (`contracts/audio.md`). Apps open PCM streams and write interleaved
 * 32-bit float samples; the service applies the master volume, mute, and the per-app volume, and the page's driver
 * plays the result. Custom `AudioWorklet` nodes need the page itself and are not available to sandboxed apps.
 */
export default async (tiny: Pear) => {
  const streams = new Map<number, Stream>()
  const mics = new Map<number, Mic>()
  const watchers = new Subscribers<{ port: number }>(tiny)
  const host = hostBridge(tiny, 'audio')
  const mix = { volume: 1, muted: false, appVolumes: {} as Record<string, number>, mutedApps: [] as string[], device: null as string | null }
  const hostState = { context: 'suspended' as string, baseLatency: 0, outputLatency: 0 }
  let nextId = 1
  const wasPlaying = new Set<string>()

  const load = async () => {
    mix.volume = Number(await tiny.configGet('tiny.audio', 'volume', 1))
    mix.muted = Boolean(await tiny.configGet('tiny.audio', 'muted', false))
    mix.device = ((await tiny.configGet('tiny.audio', 'device', null)) as string | null) ?? null
    mix.appVolumes = ((await tiny.configGet('tiny.audio', 'appVolumes', {})) as Record<string, number>) ?? {}
    mix.mutedApps = ((await tiny.configGet('tiny.audio', 'mutedApps', [])) as string[]) ?? []
  }
  await load()

  const gainFor = (appId: string | null) => {
    if (mix.muted || (appId && mix.mutedApps.includes(appId))) return 0
    return mix.volume * (appId ? (mix.appVolumes[appId] ?? 1) : 1)
  }
  const closeStream = async (s: Stream) => {
    streams.delete(s.id)
    void host.emit('close', { stream: s.id }).catch(() => {})
  }
  const owners = new Owners(tiny, async (pid) => {
    for (const s of [...streams.values()]) if (s.owner === pid) await closeStream(s)
    for (const [id, m] of mics) {
      if (m.owner !== pid) continue
      mics.delete(id)
      void host.emit('micClose', { stream: id }).catch(() => {})
    }
  })
  const own = (id: unknown, from: number): Stream => {
    const s = streams.get(id as number)
    if (!s) throw fail('ENOENT', 'no such stream')
    if (s.owner !== from && from !== 1) throw fail('EPERM', 'not your stream')
    return s
  }
  const pushMix = () => void host.emit('mix', { volume: mix.volume, muted: mix.muted, device: mix.device }).catch(() => {})

  // speaker indicator: tell watchers when an app starts or stops making sound
  setInterval(() => {
    const now = Date.now()
    const active = new Map<string, { appId: string | null; pid: number }>()
    for (const s of streams.values()) if (s.audible && now - s.lastWrite < PLAYING_MS) active.set(`${s.appId ?? ''}:${s.owner}`, { appId: s.appId, pid: s.owner })
    for (const [key, v] of active) if (!wasPlaying.has(key)) (wasPlaying.add(key), void watchers.send({ type: 'playback', playing: true, ...v }))
    for (const key of [...wasPlaying]) {
      if (active.has(key)) continue
      wasPlaying.delete(key)
      const [appId, pid] = key.split(':')
      void watchers.send({ type: 'playback', playing: false, appId: appId || null, pid: Number(pid) })
    }
  }, 250)

  const system = async (m: any, what: string) => needSystem(tiny, m, what)
  const save = async (key: string, value: unknown) => tiny.configSet('tiny.audio', key, value)

  return serve(
    tiny,
    'tiny.audio',
    {
      state: () => ({
        ...hostState, volume: mix.volume, muted: mix.muted, device: mix.device,
        playing: [...streams.values()].filter((s) => s.audible && Date.now() - s.lastWrite < PLAYING_MS).map((s) => ({ stream: s.id, pid: s.owner, appId: s.appId })),
        streams: streams.size,
      }),
      volume: () => ({ volume: mix.volume, muted: mix.muted }),
      setVolume: async (a, m) => {
        await system(m, 'change the volume')
        mix.volume = clamp01(a.volume, 'volume')
        await save('volume', mix.volume)
        pushMix()
        await watchers.send({ type: 'volume', volume: mix.volume, muted: mix.muted })
      },
      mute: async (a, m) => {
        await system(m, 'mute the sound')
        mix.muted = Boolean(a.on)
        await save('muted', mix.muted)
        pushMix()
        await watchers.send({ type: 'volume', volume: mix.volume, muted: mix.muted })
      },
      appVolumes: () => ({ volumes: mix.appVolumes, muted: mix.mutedApps }),
      setAppVolume: async (a, m) => {
        await system(m, 'change an app volume')
        if (typeof a.app !== 'string' || !a.app) throw fail('EINVAL', 'app is a bundle id')
        mix.appVolumes = { ...mix.appVolumes, [a.app]: clamp01(a.volume, 'volume') }
        await save('appVolumes', mix.appVolumes)
        await watchers.send({ type: 'app-volume', app: a.app, volume: mix.appVolumes[a.app] })
      },
      muteApp: async (a, m) => {
        await system(m, 'mute an app')
        if (typeof a.app !== 'string' || !a.app) throw fail('EINVAL', 'app is a bundle id')
        mix.mutedApps = a.on ? [...new Set([...mix.mutedApps, a.app])] : mix.mutedApps.filter((x) => x !== a.app)
        await save('mutedApps', mix.mutedApps)
        await watchers.send({ type: 'app-mute', app: a.app, muted: Boolean(a.on) })
      },
      devices: () => host.call('devices'),
      setDevice: async (a, m) => {
        await system(m, 'choose the output device')
        if (a.id !== null && typeof a.id !== 'string') throw fail('EINVAL', 'id is a device id or null for the default')
        await host.call('setDevice', { id: a.id })
        mix.device = a.id
        await save('device', a.id)
        await watchers.send({ type: 'device', id: a.id })
      },

      open: async (a, m) => {
        const sampleRate = a.sampleRate ?? 48000
        const channels = a.channels ?? 2
        const kind = a.kind ?? 'playback'
        if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 96000) throw fail('EINVAL', 'sampleRate is 8000 to 96000')
        if (!Number.isInteger(channels) || channels < 1 || channels > 8) throw fail('EINVAL', 'channels is 1 to 8')
        if (!KINDS.includes(kind)) throw fail('EINVAL', `kind is one of ${KINDS.join(', ')}`)
        if ([...streams.values()].filter((s) => s.owner === m.from).length >= MAX_STREAMS_PER_PROCESS) throw fail('EMFILE', 'too many audio streams')
        const appId = m.from === 1 ? null : (await tiny.info(m.from)).appId
        const s: Stream = { id: nextId++, owner: m.from, appId, sampleRate, channels, kind, lastWrite: 0, audible: false, frames: 0 }
        streams.set(s.id, s)
        owners.add(m.from)
        void host.emit('open', { stream: s.id, sampleRate, channels, kind }).catch(() => {})
        return s.id
      },
      write: (a, m) => {
        const s = own(a.stream, m.from)
        const raw = a.buffer
        const bytes = raw instanceof ArrayBuffer ? raw : raw instanceof Float32Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) : null
        if (!bytes) throw fail('EINVAL', 'buffer is an ArrayBuffer or Float32Array of interleaved samples')
        if (bytes.byteLength > MAX_CHUNK_BYTES) throw fail('E2BIG', `write at most ${MAX_CHUNK_BYTES} bytes at a time`)
        const frameBytes = 4 * s.channels
        if (bytes.byteLength === 0 || bytes.byteLength % frameBytes) throw fail('EINVAL', `a frame is ${s.channels} float32 samples`)
        const gain = gainFor(s.appId)
        const frames = bytes.byteLength / frameBytes
        s.lastWrite = Date.now()
        s.audible = gain > 0
        s.frames += frames
        if (gain > 0) {
          const samples = new Float32Array(bytes)
          if (gain !== 1) for (let i = 0; i < samples.length; i++) samples[i]! *= gain
          void host.emit('pcm', { stream: s.id, sampleRate: s.sampleRate, channels: s.channels, samples }).catch(() => {})
        }
        return { frames, gain }
      },
      close: (a, m) => closeStream(own(a.stream, m.from)),
      streams: (_a, m) => [...streams.values()].filter((s) => s.owner === m.from || m.from === 1).map(({ id, sampleRate, channels, kind, frames }) => ({ id, sampleRate, channels, kind, frames })),

      sound: async (a) => {
        const name = a.name
        if (typeof name !== 'string' || !/^[A-Za-z0-9 _-]{1,64}$/.test(name)) throw fail('EINVAL', 'name is a system sound such as "alert"')
        const dir = '/System/Library/Sounds'
        const entries = await tiny.readdir(dir).catch(() => [])
        const file = entries.find((e) => SOUND_EXT.some((x) => e.name.toLowerCase() === `${name.toLowerCase()}.${x}`))
        if (!file) throw fail('ENOENT', `no system sound called ${name}`)
        const gain = gainFor(null)
        if (gain === 0) return { played: false }
        await host.emit('sound', { name, file: file.name, bytes: await tiny.readFile(`${dir}/${file.name}`), gain })
        return { played: true }
      },
      sounds: async () => {
        const entries = await tiny.readdir('/System/Library/Sounds').catch(() => [])
        return entries.map((e) => e.name.replace(/\.[^.]+$/, '')).sort()
      },
      node: () => {
        throw fail('ENOSYS', 'custom audio nodes need the page: write PCM to a stream instead')
      },

      inputRequest: async (a, m) => {
        await needCapability(tiny, m, 'audio.input', 'use the microphone')
        const port = needPort(m, 'pass a port in rights to receive the samples')
        if ([...mics.values()].filter((x) => x.owner === m.from).length >= 2) throw fail('EMFILE', 'too many microphone streams')
        const id = nextId++
        const info = await host.call('micOpen', { stream: id, sampleRate: a.sampleRate ?? 48000 }, 15_000)
        mics.set(id, { id, owner: m.from, port })
        owners.add(m.from)
        return { stream: id, sampleRate: info?.sampleRate ?? 48000, channels: info?.channels ?? 1 }
      },
      inputClose: (a, m) => {
        const mic = mics.get(a.stream)
        if (!mic) return false
        if (mic.owner !== m.from && m.from !== 1) throw fail('EPERM', 'not your microphone stream')
        mics.delete(mic.id)
        void host.emit('micClose', { stream: mic.id }).catch(() => {})
        return true
      },

      ...subscription(watchers),
    },
    async (d) => {
      if (d?.type === 'config-changed' && d.domain === 'tiny.audio') {
        await load()
        pushMix()
        return watchers.send({ type: 'volume', volume: mix.volume, muted: mix.muted })
      }
      const data = d?.type === 'driver' ? d.data : null
      if (!data || host.reply(data)) return
      switch (data.event) {
        case 'context':
          hostState.context = String(data.state)
          hostState.baseLatency = Number(data.baseLatency) || 0
          hostState.outputLatency = Number(data.outputLatency) || 0
          return watchers.send({ type: 'state', ...hostState })
        case 'devices-changed':
          return watchers.send({ type: 'devices-changed' })
        case 'mic': {
          const mic = mics.get(data.stream)
          if (mic) await tiny.send(mic.port, { type: 'mic', stream: mic.id, samples: data.samples, sampleRate: data.sampleRate ?? 48000, channels: data.channels ?? 1 }).catch((e: { code?: string }) => {
            if (e?.code === 'EPIPE') (mics.delete(mic.id), void host.emit('micClose', { stream: mic.id }).catch(() => {}))
          })
          return
        }
      }
    },
    async (port) => void (await tiny.configWatch('tiny.audio', null, port)),
  )
}
