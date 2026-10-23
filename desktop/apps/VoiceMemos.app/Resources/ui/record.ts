// Recording. The window is a sandboxed iframe (opaque origin, nothing in its permissions policy),
// and the browser normally refuses the microphone there — and if `getUserMedia` were granted, the
// samples land here, not in the app's process: `tiny.audio`'s microphone (`inputRequest`) hands a
// port to a process, which window scripts cannot create (`desktop/sdk/client.ts` omits the port
// calls). So the attempt below is defensive by design: anything short of a granted, working stream
// surfaces as `null`, and the app shows its honest "microphone isn't available in this shell"
// state. If a stream IS granted, real bytes are captured with MediaRecorder and decoded to PCM.

import { decodeAudio } from './wav'

/** The window's microphone stream, or null when the browser refuses it (the usual case here). */
export async function micStream(): Promise<MediaStream | null> {
  const md = (navigator as { mediaDevices?: MediaDevices }).mediaDevices
  if (!md?.getUserMedia) return null
  try {
    const asked = md.getUserMedia({ audio: { echoCancellation: true } })
    return await Promise.race([asked, new Promise<null>((r) => setTimeout(() => r(null), 3000))])
  } catch {
    return null
  }
}

export interface Recording {
  /** Captured audio as mono floats, -1..1. */
  samples: Float32Array
  /** The rate the stream was decoded at. */
  rate: number
}

/** A MediaRecorder capture that decodes itself into PCM when stopped. */
export class Recorder {
  private rec: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private chunks: Blob[] = []

  /** Live capture is on (between start and the state change to inactive). */
  running(): boolean {
    return this.rec !== null && this.rec.state !== 'inactive'
  }

  /** Begin capturing. The caller has already obtained `stream` through `micStream`. */
  start(stream: MediaStream): void {
    this.stream = stream
    this.chunks = []
    const rec = new MediaRecorder(stream) // browser default codec; decoded again below
    rec.ondataavailable = (e) => {
      if (e.data.size) this.chunks.push(e.data)
    }
    this.rec = rec
    rec.start()
  }

  /** Tear the capture down and decode what was captured. Null: nothing usable came out. */
  async stop(): Promise<Recording | null> {
    const rec = this.rec
    const stream = this.stream
    this.rec = null
    this.stream = null
    if (!rec || !stream) return null
    const captured = Promise.race([
      new Promise<Blob | null>((resolve) => {
        rec.onstop = () => resolve(this.chunks.length ? new Blob(this.chunks) : null)
      }),
      new Promise<null>((r) => setTimeout(() => r(null), 2000)),
    ])
    try {
      rec.stop()
    } catch {
      // already inactive: the race above has the chunks if any arrived
    }
    stream.getTracks().forEach((t) => t.stop())
    const blob = await captured
    if (!blob) return null
    try {
      const pcm = await decodeAudio(new Uint8Array(await blob.arrayBuffer()))
      return { samples: pcm.data, rate: pcm.rate }
    } catch {
      return null // a container the browser cannot decode: treated as no recording
    }
  }
}
