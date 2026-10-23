// The memo format (`~/Music/Voice Memos/*.wav`): 16-bit mono PCM. `encodeWav` is the inverse of the
// `wavBytes` fixture in `desktop/tests/media.spec.ts` — the same RIFF/`fmt `/`data` header fields,
// written instead of parsed — and `decodeAudio` is the whole-file decode Music uses for durations
// and playback (desktop/apps/Music.app/Resources/ui/main.ts), downmixed to one channel.

export interface Pcm {
  /** Interleaved mono samples, -1..1. */
  data: Float32Array
  /** Sample rate. */
  rate: number
  /** Always 1: everything is mono for the `tiny.audio` stream. */
  channels: number
}

/** `0:06`-style label. */
export function fmtTime(secs: number): string {
  return `${Math.floor(secs / 60)}:${String(Math.floor(Math.max(0, secs) % 60)).padStart(2, '0')}`
}

const clamp1 = (v: number) => Math.max(-1, Math.min(1, v))

/** Encode mono floats as a 16-bit PCM WAV at `rate`. */
export function encodeWav(samples: Float32Array, rate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2)
  const view = new DataView(out.buffer)
  const write = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i)
  }
  write(0, 'RIFF')
  view.setUint32(4, out.length - 8, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round(clamp1(samples[i] ?? 0) * 0x7fff), true)
  return out
}

let decodeCtx: AudioContext | null = null

/** Decode any audio the browser knows into mono floats, at the file's rate when the mixer accepts it. */
export async function decodeAudio(bytes: Uint8Array): Promise<Pcm> {
  if (!decodeCtx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    decodeCtx = new C() // suspended until a gesture in this window; decoding works either way
  }
  const abuf = await decodeCtx.decodeAudioData(bytes.slice().buffer as ArrayBuffer)
  const frames = abuf.length
  const channels = abuf.numberOfChannels
  if (!frames || !channels) throw new Error('no audio in this file')
  let data: Float32Array
  if (channels === 1) {
    data = abuf.getChannelData(0)!.slice() // a private copy: the buffer is reused by later decodes
  } else {
    data = new Float32Array(frames)
    for (let ch = 0; ch < channels; ch++) {
      const from = abuf.getChannelData(ch)!
      for (let i = 0; i < frames; i++) data[i] = (data[i] ?? 0) + from[i]! / channels
    }
  }
  // rates the mixer cannot take (192 kHz capture, 6 kHz voice hints) fall back by linear decimation,
  // the same way Music's engine does
  const rate = abuf.sampleRate
  if (rate >= 8000 && rate <= 96000) return { data, rate, channels: 1 }
  const target = rate > 96000 ? 48000 : 22050
  const step = rate / target
  const nf = Math.max(1, Math.floor(frames / step))
  const res = new Float32Array(nf)
  for (let i = 0; i < nf; i++) res[i] = data[Math.min(frames - 1, Math.floor(i * step))]!
  return { data: res, rate: target, channels: 1 }
}
