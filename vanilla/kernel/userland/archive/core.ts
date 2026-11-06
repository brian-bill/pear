// Compression, CRC-32 and the tar and zip formats, shared by gzip, tar, zip and unzip.
import { concatBytes } from '../lib'

export async function transform(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
  return new Uint8Array(await new Response(out).arrayBuffer())
}
export const gzip = (d: Uint8Array) => transform(d, new CompressionStream('gzip'))
export const gunzip = (d: Uint8Array) => transform(d, new DecompressionStream('gzip'))
export const deflateRaw = (d: Uint8Array) => transform(d, new CompressionStream('deflate-raw'))
export const inflateRaw = (d: Uint8Array) => transform(d, new DecompressionStream('deflate-raw'))
export const isGzip = (d: Uint8Array) => d.length > 2 && d[0] === 0x1f && d[1] === 0x8b

const TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff
  for (const b of data) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

const enc = new TextEncoder()
const dec = new TextDecoder()

// ------------------------------------------------------------------------------------------------------ tar

export interface TarEntry {
  name: string
  kind: 'file' | 'dir' | 'symlink'
  mode: number
  uid: number
  gid: number
  mtime: number
  size: number
  link?: string
  data?: Uint8Array
}

const octal = (n: number, width: number) => n.toString(8).padStart(width - 1, '0') + '\0'

function header(e: TarEntry, name: string, prefix: string, type: string, size: number): Uint8Array {
  const h = new Uint8Array(512)
  const put = (s: string, at: number, max: number) => h.set(enc.encode(s).subarray(0, max), at)
  put(name, 0, 100)
  put(octal(e.mode & 0o7777, 8), 100, 8)
  put(octal(e.uid, 8), 108, 8)
  put(octal(e.gid, 8), 116, 8)
  put(octal(size, 12), 124, 12)
  put(octal(Math.floor(e.mtime / 1000), 12), 136, 12)
  put('        ', 148, 8)
  put(type, 156, 1)
  put(e.link ?? '', 157, 100)
  put('ustar\0', 257, 6)
  put('00', 263, 2)
  put(prefix, 345, 155)
  let sum = 0
  for (const b of h) sum += b
  put(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return h
}

export function tarCreate(entries: TarEntry[]): Uint8Array {
  const parts: Uint8Array[] = []
  const pad = (n: number) => new Uint8Array((512 - (n % 512)) % 512)
  for (const e of entries) {
    let name = e.kind === 'dir' && !e.name.endsWith('/') ? `${e.name}/` : e.name
    let prefix = ''
    if (enc.encode(name).length > 100) {
      const cut = name.lastIndexOf('/', name.length - 2)
      if (cut > 0 && enc.encode(name.slice(0, cut)).length <= 155 && enc.encode(name.slice(cut + 1)).length <= 100) {
        prefix = name.slice(0, cut)
        name = name.slice(cut + 1)
      } else {
        // GNU long name entry
        const long = enc.encode(`${name}\0`)
        parts.push(header({ ...e, mode: 0o644, link: '' }, '././@LongLink', '', 'L', long.length), long, pad(long.length))
        name = name.slice(0, 100)
      }
    }
    const data = e.kind === 'file' ? (e.data ?? new Uint8Array()) : new Uint8Array()
    parts.push(header(e, name, prefix, e.kind === 'dir' ? '5' : e.kind === 'symlink' ? '2' : '0', data.length), data, pad(data.length))
  }
  parts.push(new Uint8Array(1024))
  return concatBytes(parts)
}

export function tarParse(data: Uint8Array): TarEntry[] {
  const out: TarEntry[] = []
  const str = (h: Uint8Array, at: number, len: number) => {
    const s = h.subarray(at, at + len)
    const z = s.indexOf(0)
    return dec.decode(z < 0 ? s : s.subarray(0, z))
  }
  const num = (h: Uint8Array, at: number, len: number) => parseInt(str(h, at, len).trim() || '0', 8) || 0
  let at = 0
  let longName: string | null = null
  let paxPath: string | null = null
  while (at + 512 <= data.length) {
    const h = data.subarray(at, at + 512)
    if (h.every((b) => b === 0)) break
    const size = num(h, 124, 12)
    const type = String.fromCharCode(h[156] || 48)
    const body = data.subarray(at + 512, at + 512 + size)
    at += 512 + Math.ceil(size / 512) * 512
    if (type === 'L') {
      longName = dec.decode(body).replace(/\0.*$/s, '')
      continue
    }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(dec.decode(body))
      if (m) paxPath = m[1]!
      continue
    }
    if (type === 'g') continue
    const prefix = str(h, 345, 155)
    let name = longName ?? paxPath ?? (prefix ? `${prefix}/${str(h, 0, 100)}` : str(h, 0, 100))
    longName = paxPath = null
    const kind = type === '5' ? 'dir' : type === '2' ? 'symlink' : 'file'
    if (type !== '0' && type !== '5' && type !== '2' && type !== '\0' && type !== '7') continue
    if (kind === 'dir') name = name.replace(/\/+$/, '')
    out.push({ name, kind, mode: num(h, 100, 8), uid: num(h, 108, 8), gid: num(h, 116, 8), mtime: num(h, 136, 12) * 1000, size, link: kind === 'symlink' ? str(h, 157, 100) : undefined, data: kind === 'file' ? body.slice() : undefined })
  }
  return out
}

// ------------------------------------------------------------------------------------------------------ zip

export interface ZipEntry {
  name: string
  data: Uint8Array
  dir: boolean
  mtime: number
  mode: number
}

const dosTime = (ms: number): [number, number] => {
  const d = new Date(ms)
  return [(d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()]
}

export async function zipCreate(entries: ZipEntry[]): Promise<Uint8Array> {
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.dir && !e.name.endsWith('/') ? `${e.name}/` : e.name)
    const raw = e.dir ? new Uint8Array() : e.data
    const packed = e.dir || raw.length === 0 ? raw : await deflateRaw(raw)
    const method = packed.length < raw.length ? 8 : 0
    const body = method === 8 ? packed : raw
    const [time, date] = dosTime(e.mtime)
    const crc = crc32(raw)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint16(6, 0x0800, true)
    local.setUint16(8, method, true)
    local.setUint16(10, time, true)
    local.setUint16(12, date, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, body.length, true)
    local.setUint32(22, raw.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, body)
    const c = new DataView(new ArrayBuffer(46))
    c.setUint32(0, 0x02014b50, true)
    c.setUint16(4, 0x031e, true)
    c.setUint16(6, 20, true)
    c.setUint16(8, 0x0800, true)
    c.setUint16(10, method, true)
    c.setUint16(12, time, true)
    c.setUint16(14, date, true)
    c.setUint32(16, crc, true)
    c.setUint32(20, body.length, true)
    c.setUint32(24, raw.length, true)
    c.setUint16(28, name.length, true)
    c.setUint32(38, ((e.dir ? 0o40000 : 0o100000) | (e.mode & 0o7777)) * 65536 + (e.dir ? 0x10 : 0), true)
    c.setUint32(42, offset, true)
    central.push(new Uint8Array(c.buffer), name)
    offset += 30 + name.length + body.length
  }
  const cd = concatBytes(central)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  end.setUint16(8, entries.length, true)
  end.setUint16(10, entries.length, true)
  end.setUint32(12, cd.length, true)
  end.setUint32(16, offset, true)
  return concatBytes([...parts, cd, new Uint8Array(end.buffer)])
}

export interface ZipItem {
  name: string
  dir: boolean
  size: number
  mtime: number
  mode: number
  read(): Promise<Uint8Array>
}

export function zipList(data: Uint8Array): ZipItem[] {
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength)
  let eocd = -1
  for (let i = data.length - 22; i >= Math.max(0, data.length - 65557); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip file')
  const count = v.getUint16(eocd + 10, true)
  let at = v.getUint32(eocd + 16, true)
  const items: ZipItem[] = []
  for (let n = 0; n < count; n++) {
    if (v.getUint32(at, true) !== 0x02014b50) throw new Error('corrupt zip directory')
    const method = v.getUint16(at + 10, true)
    const time = v.getUint16(at + 12, true)
    const date = v.getUint16(at + 14, true)
    const csize = v.getUint32(at + 20, true)
    const usize = v.getUint32(at + 24, true)
    const nlen = v.getUint16(at + 28, true)
    const elen = v.getUint16(at + 30, true)
    const clen = v.getUint16(at + 32, true)
    const attrs = v.getUint32(at + 38, true)
    const local = v.getUint32(at + 42, true)
    const name = dec.decode(data.subarray(at + 46, at + 46 + nlen))
    const mtime = new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0xf) - 1, date & 0x1f, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2).getTime()
    items.push({
      name,
      dir: name.endsWith('/'),
      size: usize,
      mtime,
      mode: (attrs >>> 16) & 0o7777 || 0o644,
      async read() {
        const lnlen = v.getUint16(local + 26, true)
        const lelen = v.getUint16(local + 28, true)
        const body = data.subarray(local + 30 + lnlen + lelen, local + 30 + lnlen + lelen + csize)
        if (method === 0) return body.slice()
        if (method === 8) return inflateRaw(body)
        throw new Error(`${name}: unsupported compression method ${method}`)
      },
    })
    at += 46 + nlen + elen + clen
  }
  return items
}
