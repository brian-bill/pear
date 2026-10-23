// Playback, modelled on Music's window engine (desktop/apps/Music.app/Resources/ui/main.ts, its
// "engine" section: the whole file is decoded first, then paced PCM chunks are posted to
// `tiny.audio`; the system mixer queues and plays them, and its own reactions — the Dock playing
// indicator, per-app volume — belong to the service, never to this app). Stripped to one press:
// every start is from the beginning, and stopping drops the queue with the stream.
//
// The mixer only sounds after a user gesture on the desktop itself, so `start` may sit in
// `waiting` until the page's AudioContext is resumed; nothing is queued until then.

import { tiny } from '@tiny/sdk'
import type { Pcm } from './wav'

const CHUNK_MS = 120 // wall-clock time between posts
/** How much of the stream is still queued ahead, as a share of the posted frames. */
const LEAD = (CHUNK_MS + 60) / 1000

let pcm: Pcm | null = null
let stream: number | null = null // the `tiny.audio` handle, open while playing
let pos = 0 // frames posted since this start
let lastPost = 0 // when the newest chunk was posted, for the interpolated playhead
let running = false
let waiting = false // play requested, audio context still suspended
let onTick: () => void = () => {}
let onEnd: (why: string | null) => void = () => {}
let tickTimer = 0
let endTimer = 0
let pollTimer = 0

/** Something is (or may soon be) sounding; the app shows Stop. */
export const active = (): boolean => running

/** The playhead: posted frames, minus what the page still has queued, plus the time since then. */
export function elapsed(): number {
  if (!pcm || !running) return 0
  const base = Math.max(0, pos - Math.round(pcm.rate * LEAD))
  const since = Math.min(LEAD, Math.max(0, (performance.now() - lastPost) / 1000))
  const frames = Math.min(pcm.data.length, base + Math.round(pcm.rate * since))
  return frames / (pcm.rate || 1)
}

const totalFrames = (): number => (pcm?.data.length ?? 0)

/** Post one paced chunk to the mixer; the page queues the chunks and plays them in order. */
function post(): void {
  if (!pcm || stream === null || !running) return
  const left = totalFrames() - pos
  if (left <= 0) return
  const frames = Math.min(Math.round((pcm.rate * CHUNK_MS) / 1000), left)
  if (frames <= 0) return
  const samples = pcm.data.subarray(pos, pos + frames)
  void tiny
    .service('tiny.audio', { op: 'write', stream, buffer: samples })
    .catch((e: Error) => {
      if (stream === null) return // the stream was closed while the call was in flight
      stream = null
      finish(e.message)
    })
  pos += frames
  lastPost = performance.now()
  onTick()
  if (pos >= totalFrames()) scheduleEnd()
}

function scheduleEnd(): void {
  clearTimeout(endTimer)
  // everything posted is queued at the page or already sounding; estimate when the rest stops ringing
  const rest = ((totalFrames() - pos) / (pcm ? pcm.rate : 1)) * 1000
  endTimer = window.setTimeout(() => {
    if (running) finish(null)
  }, Math.max(200, rest + CHUNK_MS / 2))
}

function closeStream(): void {
  clearInterval(tickTimer)
  clearTimeout(endTimer)
  tickTimer = 0
  endTimer = 0
  if (stream !== null) void tiny.service('tiny.audio', { op: 'close', stream }).catch(() => {})
  stream = null
}

/** Stop posting; the queue at the page is dropped with the stream. */
export function pause(): void {
  running = false
  waiting = false
  closeStream()
  clearInterval(pollTimer)
}

/** End of this play (button, end of file, or `why` when something went wrong). */
function finish(why: string | null): void {
  pause()
  pos = 0
  lastPost = 0
  onEnd(why)
}

/** The pressed Stop button: as `pause`, then tell the UI the play ended. */
export function stop(): void {
  const was = running || waiting
  pause()
  pos = 0
  lastPost = 0
  if (was) onEnd(null)
}

async function audioRunning(): Promise<boolean> {
  try {
    const state = (await tiny.service('tiny.audio', { op: 'state' })) as { context?: unknown }
    return String(state.context) === 'running'
  } catch {
    return true // ask forgiveness: the write itself will say no
  }
}

/** Play `data` from `fromSecs`; does not decode — the caller hands over ready PCM. */
export function start(data: Pcm, fromSecs: number, tick: () => void, end: (why: string | null) => void): void {
  pause()
  pcm = data
  running = true
  pos = Math.round(Math.max(0, fromSecs) * data.rate)
  onTick = tick
  onEnd = end
  void audioRunning().then((ok) => {
    if (!running) return
    if (ok) begin()
    else {
      // the browser's audio unlock happens on the next click in the desktop; wait for it visibly
      waiting = true
      onTick()
      clearInterval(pollTimer)
      pollTimer = window.setInterval(() => {
        void audioRunning().then((again) => {
          if (!running) {
            clearInterval(pollTimer)
          } else if (again) {
            clearInterval(pollTimer)
            waiting = false
            begin()
          }
        })
      }, 200)
    }
  })
}

function begin(): void {
  void (async () => {
    if (!pcm || !running) return
    const current = pcm
    try {
      stream = (await tiny.service('tiny.audio', { op: 'open', sampleRate: current.rate, channels: 1, kind: 'voice' })) as number
    } catch (e) {
      finish(`audio could not start (${(e as Error).message})`)
      return
    }
    post()
    tickTimer = window.setInterval(() => running && post(), CHUNK_MS)
    scheduleEnd()
  })()
}
