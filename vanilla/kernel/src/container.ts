/// The single-stream container shared by `.tinyimg` (disk images, `image.ts`) and `.pearapp` (app packages, `pearapp.ts`):
///
///   magic (8) | version u16 | flags u16 | header length u32 | header (JSON) | body | "END!" | crc32 u32
///
/// The body is a run of records, `meta length u32 | meta (JSON) | content (meta.size bytes, for files)`, ended by a
/// record of length 0. It is gzip-compressed when `flags` bit 0 is set. The checksum covers every byte before `END!` as
/// stored, so a damaged file is detected without decompressing it. One implementation, so a fix lands in both formats.
import { SysError } from './errors'

export const FLAG_GZIP = 1
export const TRAILER = 'END!'
export const FIXED = 8 + 2 + 2 + 4

const enc = new TextEncoder()
const dec = new TextDecoder()

// ---- checksum

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export async function crc32(blob: Blob): Promise<number> {
  let c = 0xffffffff
  const reader = blob.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    for (let i = 0; i < value.length; i++) c = TABLE[(c ^ value[i]!) & 0xff]! ^ (c >>> 8)
  }
  return (c ^ 0xffffffff) >>> 0
}

export const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

export function concat(parts: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export class ByteReader {
  private buf: Uint8Array = new Uint8Array(0)
  private reader: ReadableStreamDefaultReader<Uint8Array>
  constructor(stream: ReadableStream<Uint8Array>) {
    this.reader = stream.getReader()
  }
  async read(n: number): Promise<Uint8Array> {
    if (n === 0) return new Uint8Array(0)
    const parts: Uint8Array[] = [this.buf]
    let have = this.buf.length
    while (have < n) {
      const { done, value } = await this.reader.read()
      if (done) throw new SysError('EIO', 'the file ends early')
      parts.push(value)
      have += value.length
    }
    const all: Uint8Array = parts.length === 1 ? parts[0]! : concat(parts, have)
    this.buf = all.subarray(n)
    return all.subarray(0, n)
  }
  cancel(): void {
    void this.reader.cancel().catch(() => {})
  }
}

// ---- records

/** One record: its metadata, and the content if it is a file. Append to the body parts, then end with `END_RECORD`. */
export function record(meta: object, content?: Uint8Array): BlobPart[] {
  const json = enc.encode(JSON.stringify(meta))
  const head = u32(json.length) as BlobPart
  return content ? [head, json as BlobPart, content as BlobPart] : [head, json as BlobPart]
}
export const END_RECORD = u32(0)

/** The next record, or `null` at the end record. A file's content follows its metadata (`meta.size` bytes). */
export async function readRecord<M extends { kind?: string; size?: number }>(reader: ByteReader, maxContent = Infinity): Promise<{ meta: M; content: Uint8Array | null } | null> {
  const len = new DataView((await reader.read(4)).slice().buffer).getUint32(0, true)
  if (len === 0) return null
  if (len > 64 * 1024) throw new SysError('EIO', 'a record header is too large')
  const meta = JSON.parse(dec.decode(await reader.read(len))) as M
  if (meta.kind === 'file' && !(Number.isInteger(meta.size) && (meta.size as number) >= 0 && (meta.size as number) <= maxContent)) throw new SysError('EINVAL', 'a file in the package is larger than allowed')
  const content = meta.kind === 'file' ? await reader.read(meta.size ?? 0) : null
  return { meta, content }
}

/** The records of a body, decompressed if the container said so. */
export const bodyStream = (body: Blob, gzip: boolean): ReadableStream<Uint8Array> =>
  gzip ? body.stream().pipeThrough(new DecompressionStream('gzip')) : (body.stream() as ReadableStream<Uint8Array>)

export const gzipped = (body: Blob): Promise<Blob> => new Response(body.stream().pipeThrough(new CompressionStream('gzip'))).blob()

// ---- frame

/** Wrap a body in the container: the fixed head, the JSON header, the body, and the trailer with the checksum. */
export async function frame(magic: string, version: number, flags: number, header: object, body: Blob, type: string): Promise<Blob> {
  const json = enc.encode(JSON.stringify(header))
  const fixed = new Uint8Array(FIXED)
  const dv = new DataView(fixed.buffer)
  fixed.set(enc.encode(magic), 0)
  dv.setUint16(8, version, true)
  dv.setUint16(10, flags, true)
  dv.setUint32(12, json.length, true)
  const head = new Blob([fixed, json as BlobPart, body])
  return new Blob([head, enc.encode(TRAILER) as BlobPart, u32(await crc32(head)) as BlobPart], { type })
}

export interface Unframed {
  header: unknown
  body: Blob
  gzip: boolean
  version: number
}

/** Check the magic, version, trailer and checksum, and give back the header and the body. Nothing is decompressed. */
export async function unframe(file: Blob, o: { magic: string; version: number; minVersion: number; what: string; noun: string }): Promise<Unframed> {
  if (file.size < FIXED + TRAILER.length + 4) throw new SysError('EINVAL', `not a ${o.what}`)
  const fixed = new Uint8Array(await file.slice(0, FIXED).arrayBuffer())
  if (dec.decode(fixed.subarray(0, 8)) !== o.magic) throw new SysError('EINVAL', `not a ${o.what}`)
  const dv = new DataView(fixed.buffer)
  const version = dv.getUint16(8, true)
  if (version > o.version) throw new SysError('EINVAL', `this ${o.noun} is version ${version}; this system reads up to ${o.version}`)
  if (version < o.minVersion) throw new SysError('EINVAL', `${o.noun} version ${version} is too old to read`)
  const gzip = (dv.getUint16(10, true) & FLAG_GZIP) !== 0
  const headerLen = dv.getUint32(12, true)
  const end = file.size - (TRAILER.length + 4)
  if (FIXED + headerLen > end) throw new SysError('EIO', `the ${o.noun} is damaged`)

  const trailer = new Uint8Array(await file.slice(end).arrayBuffer())
  if (dec.decode(trailer.subarray(0, TRAILER.length)) !== TRAILER) throw new SysError('EIO', `the ${o.noun} is incomplete`)
  if ((await crc32(file.slice(0, end))) !== new DataView(trailer.buffer).getUint32(TRAILER.length, true)) throw new SysError('EIO', `the ${o.noun} is damaged (checksum mismatch)`)

  let header: unknown
  try {
    header = JSON.parse(dec.decode(new Uint8Array(await file.slice(FIXED, FIXED + headerLen).arrayBuffer())))
  } catch {
    throw new SysError('EIO', `the ${o.noun} header is damaged`)
  }
  return { header, body: file.slice(FIXED + headerLen, end), gzip, version }
}
