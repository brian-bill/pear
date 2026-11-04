/** A minimal zip writer (stored entries), so tests can build a real .vsix. */
function crc32(b: Uint8Array): number {
  let c = ~0
  for (const x of b) {
    c ^= x
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return ~c >>> 0
}
export function zip(files: Record<string, string>): number[] {
  const enc = new TextEncoder()
  const out: number[] = []
  const central: number[] = []
  const le = (n: number, bytes: number): number[] => Array.from({ length: bytes }, (_, i) => (n >>> (8 * i)) & 0xff)
  for (const [name, text] of Object.entries(files)) {
    const data = enc.encode(text)
    const nm = enc.encode(name)
    const crc = crc32(data)
    const offset = out.length
    out.push(...le(0x04034b50, 4), ...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(nm.length, 2), ...le(0, 2), ...nm, ...data)
    central.push(...le(0x02014b50, 4), ...le(20, 2), ...le(20, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(crc, 4), ...le(data.length, 4), ...le(data.length, 4), ...le(nm.length, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 2), ...le(0, 4), ...le(offset, 4), ...nm)
  }
  const start = out.length
  out.push(...central, ...le(0x06054b50, 4), ...le(0, 2), ...le(0, 2), ...le(Object.keys(files).length, 2), ...le(Object.keys(files).length, 2), ...le(central.length, 4), ...le(start, 4), ...le(0, 2))
  return out
}

