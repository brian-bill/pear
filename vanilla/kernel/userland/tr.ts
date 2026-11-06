import { main, parseArgs, type Pear } from './lib'

const CLASSES: Record<string, string> = {
  alpha: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', digit: '0123456789', lower: 'abcdefghijklmnopqrstuvwxyz', upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  alnum: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', space: ' \t\n\r\f\v', blank: ' \t', punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~', xdigit: '0123456789abcdefABCDEF',
}

/** `a-z`, `[:upper:]`, `\n`: the characters a set names, in order. */
function expand(set: string): string[] {
  const out: string[] = []
  const chars = [...set]
  for (let i = 0; i < chars.length; i++) {
    let c = chars[i]!
    if (c === '[' && chars[i + 1] === ':') {
      const end = set.indexOf(':]', i)
      const name = chars.slice(i + 2, end).join('')
      if (end > 0 && CLASSES[name]) {
        out.push(...CLASSES[name]!)
        i = [...set.slice(0, end + 2)].length - 1
        continue
      }
    }
    if (c === '\\' && i + 1 < chars.length) {
      const n = chars[++i]!
      const oct = /^[0-7]{1,3}/.exec(chars.slice(i).join(''))
      if (oct) {
        c = String.fromCharCode(parseInt(oct[0], 8))
        i += oct[0].length - 1
      } else c = n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n
    }
    if (chars[i + 1] === '-' && i + 2 < chars.length) {
      const end = chars[i + 2]!
      for (let k = c.codePointAt(0)!; k <= end.codePointAt(0)!; k++) out.push(String.fromCodePoint(k))
      i += 2
    } else out.push(c)
  }
  return out
}

export default function (tiny: Pear): Promise<number> {
  return main('tr', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (!rest.length || (!flags.d && !flags.s && rest.length < 2)) {
      await tiny.stderr.write('usage: tr [-cds] string1 [string2]\n')
      return 1
    }
    const from = expand(rest[0]!)
    const to = rest[1] ? expand(rest[1]) : []
    const complement = Boolean(flags.c || flags.C)
    const inSet = (ch: string) => from.includes(ch) !== complement
    const squeezeSet = flags.s ? new Set(flags.d ? to : to.length ? to : from) : null
    const map = new Map<string, string>()
    if (!flags.d && to.length) from.forEach((c, i) => map.set(c, to[Math.min(i, to.length - 1)]!))
    const chunks: string[] = []
    const dec = new TextDecoder()
    for (let c; (c = await tiny.stdin.read()); ) chunks.push(dec.decode(c, { stream: true }))
    chunks.push(dec.decode())
    let out = ''
    let last = ''
    for (const ch of chunks.join('')) {
      let r = ch
      if (flags.d && inSet(ch)) continue
      if (!flags.d && to.length) {
        if (complement) r = inSet(ch) ? to[to.length - 1]! : ch
        else r = map.get(ch) ?? ch
      }
      if (squeezeSet && squeezeSet.has(r) && r === last) continue
      out += r
      last = r
    }
    await tiny.stdout.write(out)
  })
}
