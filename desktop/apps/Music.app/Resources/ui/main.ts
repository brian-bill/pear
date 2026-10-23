import { basename, dirname, formatBytes, tiny } from '@tiny/sdk'
import { descriptionOf, FILTERS, isAudio, mimeOf, siblings } from './media'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const titleEl = $('title')
const subEl = $('sub')
const queueEl = $('queue')
const scrubEl = $<HTMLInputElement>('scrub')
const volEl = $<HTMLInputElement>('vol')
const playBtn = $('play') as HTMLButtonElement
const nowEl = $('now')

const PlaySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>'
const PauseSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>'

// ---- engine: decode the whole file, then post paced PCM chunks to `tiny.audio`
// (the system mixer plays them in order; the Dock's playing indicator and speaker state are the
// service's own reaction to these writes, and per-app volume is set from Settings, never by the app)

const CHUNK_MS = 120 // wall-clock time between posts
/** How much of the stream is still queued ahead, as a share of the posted frames. */
const LEAD = (CHUNK_MS + 60) / 1000

interface Pcm {
  data: Float32Array // interleaved
  rate: number
  channels: number
}

let decodeCtx: AudioContext | null = null
/** Whole-file decode into interleaved floats, clamped to what a `tiny.audio` stream accepts. */
async function decode(bytes: Uint8Array): Promise<Pcm> {
  if (!decodeCtx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    decodeCtx = new C() // suspended until a gesture in the app; decoding works either way
  }
  const abuf = await decodeCtx.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
  const frames = abuf.length
  const channels = Math.min(abuf.numberOfChannels, 8)
  if (!frames || !channels) throw new Error('no audio in this file')
  const out = new Float32Array(frames * channels)
  for (let ch = 0; ch < channels; ch++) {
    const from = abuf.getChannelData(ch)
    for (let i = 0; i < frames; i++) out[i * channels + ch] = from[i]!
  }
  // out-of-range rates (192 kHz capture, 6 kHz voice hints) fall back by linear decimation
  const rate = abuf.sampleRate
  if (rate >= 8000 && rate <= 96000) return { data: out, rate, channels }
  const target = rate > 96000 ? 48000 : 22050
  const step = rate / target
  const nf = Math.max(1, Math.floor(frames / step))
  const res = new Float32Array(nf * channels)
  for (let i = 0; i < nf; i++) {
    const j = Math.min(frames - 1, Math.floor(i * step))
    for (let ch = 0; ch < channels; ch++) res[i * channels + ch] = out[j * channels + ch]!
  }
  return { data: res, rate: target, channels }
}

const song = { path: null as string | null, name: '', size: 0, mtime: 0, mime: '', ready: false }
const infoText = () => `${song.mime === 'application/octet-stream' ? '' : `${song.mime.toUpperCase()} · `}${formatBytes(song.size)} · ${song.path ? dirname(song.path) : ''}`

const queue: string[] = []
let pcm: Pcm | null = null
let stream: number | null = null // the `tiny.audio` handle, open while playing
let pos = 0 // frames posted since this start
let lastPost = 0 // when the newest chunk was posted, for the interpolated playhead
let playing = false
let waiting = false // play requested, audio context still suspended
let volume = 1 // this window's fader
let queueOn = true
let loadId = 0
let tickTimer = 0
let uiTimer = 0
let pollTimer = 0
let endTimer = 0

const totalFrames = () => (pcm ? pcm.data.length / pcm.channels : 0)
const atSecs = (frames: number) => (pcm ? frames / pcm.rate : 0)
/** The playhead: the posted frames, minus what the page still has queued, plus the time since then. */
const shownFrames = () => {
  if (!pcm || !playing) return pos
  const base = Math.max(0, pos - Math.round(pcm.rate * LEAD))
  const since = Math.min(LEAD, Math.max(0, (performance.now() - lastPost) / 1000))
  return Math.min(totalFrames(), base + Math.round(pcm.rate * since))
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
const audioRunning = async (): Promise<boolean> => {
  try {
    const state = (await tiny.service('tiny.audio', { op: 'state' })) as { context?: unknown }
    return String(state.context) === 'running'
  } catch {
    return true // ask forgiveness: the write itself will say no
  }
}

async function updateMenus(): Promise<void> {
  const started = playing && !waiting
  await tiny.window.setMenus([
    { title: 'Music', items: [{ label: 'Open…', shortcut: 'Cmd+O', action: () => void openDialog() }] },
    { title: 'Playback', items: [{ label: started ? 'Pause' : 'Play', shortcut: 'Space', action: () => toggle() }, { separator: true }, { label: 'Next Track', shortcut: 'Cmd+ArrowRight', action: () => void step(1) }, { label: 'Previous Track', shortcut: 'Cmd+ArrowLeft', action: () => void step(-1) }] },
    { title: 'View', items: [{ label: queueOn ? 'Hide Queue' : 'Show Queue', shortcut: 'Cmd+L', action: () => (queueOn = !queueOn, renderQueue(), paint()) }] },
  ])
}

function paint(): void {
  const started = playing && !waiting
  playBtn.innerHTML = started ? PauseSvg : PlaySvg
  playBtn.title = started ? 'Pause (Space)' : 'Play (Space)'
  playBtn.setAttribute('aria-label', started ? 'Pause' : 'Play')
  playBtn.disabled = !song.ready
  scrubEl.disabled = !song.ready
  scrubEl.max = atSecs(totalFrames()).toFixed(2)
  scrubEl.value = String(Math.min(Number(scrubEl.max), Number(atSecs(shownFrames()).toFixed(2))))
  $('cur').textContent = fmt(atSecs(shownFrames()))
  $('rest').textContent = `-${fmt(Math.max(0, atSecs(totalFrames() - shownFrames())))}`
  titleEl.textContent = song.path ? song.name : 'Music'
  if (!song.ready) subEl.textContent = song.path ? `${song.name} could not be decoded.` : 'Open a song with File > Open (Cmd+O)'
  else if (waiting) subEl.textContent = `${infoText()} · starts after the next click`
  else if (!started) subEl.textContent = `${infoText()} · paused`
  else subEl.textContent = infoText()
  for (const row of Array.from(queueEl.children) as HTMLElement[])
    row.classList.toggle('cur', row.dataset.path === song.path)
  void updateMenus()
}

const extOf = (p: string) => p.slice(p.lastIndexOf('.') + 1).toLowerCase()
function renderQueue(): void {
  queueEl.replaceChildren(
    ...queue.map((p) => {
      const row = document.createElement('button')
      row.className = 'qrow'
      row.dataset.path = p
      row.setAttribute('role', 'option')
      row.append(
        Object.assign(document.createElement('span'), { className: 'name', textContent: basename(p) }),
        Object.assign(document.createElement('span'), { className: 'ext', textContent: extOf(p) }),
      )
      row.addEventListener('click', () => void select(p))
      return row
    }),
  )
  queueEl.hidden = !queueOn || queue.length < 2
}

/** Read, decode and register a path as the current song. Never starts playback itself. */
async function select(p: string, autoplay = false): Promise<void> {
  const id = ++loadId
  if (!isAudio(p)) {
    await tiny.dialogs.alert({ message: `“${basename(p)}” is not audio Music can play.` })
    return
  }
  song.ready = false
  song.path = p
  song.name = basename(p)
  song.mime = mimeOf(p)
  pause(true)
  subEl.textContent = 'Reading…'
  titleEl.textContent = song.name
  try {
    const [bytes, st] = await Promise.all([tiny.readFile(p), tiny.stat(p)])
    if (id !== loadId) return
    song.size = st.size
    song.mtime = st.mtime
    const decoded = await decode(bytes)
    if (id !== loadId) return
    pcm = decoded
    song.ready = true
    pos = 0
    void tiny.window.setTitle(song.name) // the window is named for the song, like QuickTime
    queue.splice(0, queue.length, ...(await siblings(p)))
    renderQueue()
    paint()
    if (autoplay) void play()
  } catch (e) {
    if (id !== loadId) return
    song.ready = false
    pcm = null
    void tiny.window.setTitle('Music')
    paint()
    const why = (e as Error).message
    const detail = /decoder|decode/i.test(why) ? `The browser has no decoder for ${descriptionOf(song.name)}.` : why
    await tiny.dialogs.alert({ message: `“${song.name}” could not be played.`, detail })
  }
}

// ---- run control

/** Play from wherever the playhead is. */
const play = (): void => void playAt(atSecs(pos))

/** Post one paced chunk to the mixer; the page queues the chunks and plays them in order. */
function post(): void {
  if (!pcm || stream === null) return
  const total = totalFrames()
  if (pos >= total) return
  const frames = Math.min(Math.round((pcm.rate * CHUNK_MS) / 1000), total - pos)
  if (frames <= 0) return
  let samples: Float32Array = pcm.data.subarray(pos * pcm.channels, (pos + frames) * pcm.channels)
  if (volume !== 1) {
    samples = new Float32Array(samples)
    for (let i = 0; i < samples.length; i++) samples[i]! *= volume
  }
  void tiny.service('tiny.audio', { op: 'write', stream, buffer: samples }).catch(() => {
    if (stream !== null) closeStream()
  })
  pos += frames
  lastPost = performance.now()
  if (pos >= totalFrames()) scheduleEnd()
}

function scheduleEnd(): void {
  clearTimeout(endTimer)
  // everything posted is queued at the page or already sounding; estimate when the rest stops ringing
  const rest = ((totalFrames() - pos) / (pcm ? pcm.rate : 1)) * 1000
  endTimer = window.setTimeout(() => {
    if (playing) ended()
  }, Math.max(200, rest + CHUNK_MS / 2))
}

function tick(): void {
  if (playing) post()
}

/** Start ticking from `seconds`, with a fresh stream so nothing queued at the page keeps sounding. */
async function playAt(seconds: number): Promise<void> {
  if (!pcm || !song.ready) return
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0
  pause(true)
  playing = true
  pos = Math.round(Math.min(seconds, atSecs(totalFrames())) * pcm.rate)
  if (await audioRunning()) {
    waiting = false
    begin()
  } else {
    // the browser's audio unlock happens on the next click in the desktop; wait for it visibly
    waiting = true
    clearInterval(pollTimer)
    pollTimer = window.setInterval(() => {
      void audioRunning().then((ok) => {
        if (!playing) clearInterval(pollTimer)
        else if (ok) {
          clearInterval(pollTimer)
          waiting = false
          begin()
        }
      })
    }, 200)
  }
  paint()
}

function begin(): void {
  void (async () => {
    if (!pcm) return
    try {
      stream = (await tiny.service('tiny.audio', { op: 'open', sampleRate: pcm.rate, channels: pcm.channels, kind: 'media' })) as number
    } catch (e) {
      playing = false
      paint()
      await tiny.dialogs.alert({ message: 'Audio could not start.', detail: (e as Error).message })
      return
    }
    tick()
    tickTimer = window.setInterval(tick, CHUNK_MS)
    uiTimer = window.setInterval(() => playing && !seeking && paint(), 300)
    scheduleEnd()
  })()
}

/** Stop posting; the queue at the page is dropped with the stream. */
function closeStream(): void {
  clearInterval(tickTimer)
  clearInterval(uiTimer)
  clearTimeout(endTimer)
  tickTimer = 0
  uiTimer = 0
  endTimer = 0
  if (stream !== null) void tiny.service('tiny.audio', { op: 'close', stream }).catch(() => {})
  stream = null
}

function pause(keepPaint = false): void {
  playing = false
  waiting = false
  closeStream()
  clearInterval(pollTimer)
  if (!keepPaint) paint()
}

function ended(): void {
  pause(true)
  pos = 0
  lastPost = 0
  paint()
}

function toggle(): void {
  if (!song.ready) {
    void openDialog()
    return
  }
  if (playing) {
    // while `waiting`, this very click is the unlock; the poller starts the stream (the next click pauses)
    if (!waiting) pause()
    return
  }
  void playAt(atSecs(pos))
}

async function step(d: number): Promise<void> {
  if (queue.length < 2 || !song.path) return
  const i = (queue.indexOf(song.path) + d + queue.length) % queue.length
  void select(queue[i]!, playing && !waiting)
}

async function openDialog(): Promise<void> {
  const picked = await tiny.dialogs.openFile({ title: 'Open', startIn: song.path ? dirname(song.path) : undefined, filters: FILTERS })
  if (picked?.[0]) await select(picked[0], !playing)
}

// ---- input

nowEl.addEventListener('click', () => toggle())
playBtn.addEventListener('click', () => toggle())
$('prev').addEventListener('click', () => void step(-1))
$('next').addEventListener('click', () => void step(1))

let seeking = false
scrubEl.addEventListener('input', () => (seeking = true))
scrubEl.addEventListener('change', () => {
  seeking = false
  const frac = Number(scrubEl.value) / Math.max(Number(scrubEl.max), 0.01)
  if (playing) void playAt(frac * atSecs(totalFrames()))
  else {
    pos = Math.round(frac * totalFrames())
    paint()
  }
})
volEl.addEventListener('input', () => {
  volume = Number(volEl.value)
})

addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === ' ') {
    e.preventDefault()
    toggle()
  }
})

// ---- app wiring

async function main(): Promise<void> {
  await tiny.ready
  const state = tiny.app.state as { path?: string | null } | undefined | null
  const first = state?.path ?? tiny.app.args[0]
  tiny.app.onOpenFile((p) => void select(p, true))
  if (first) await select(first, false) // restored sessions resume paused
  renderQueue()
  paint()
  scrubEl.focus()
}

void main()
