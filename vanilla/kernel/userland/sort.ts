import { decoder, main, parseArgs, readAllText, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('sort', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['k', 't', 'o'])
    const files = rest.length ? rest : ['-']
    let lines: string[] = []
    for (const f of files) {
      const text = await readAllText(tiny, f)
      lines.push(...text.split('\n').slice(0, text.endsWith('\n') ? -1 : undefined))
    }
    const sep = typeof flags.t === 'string' ? flags.t : null
    const keySpec = typeof flags.k === 'string' ? /^(\d+)(?:,(\d+))?([a-zA-Z]*)$/.exec(flags.k) : null
    const keyOf = (line: string): string => {
      if (!keySpec) return line
      const fields = sep ? line.split(sep) : line.trim().split(/\s+/)
      const from = Number(keySpec[1]) - 1
      const to = keySpec[2] ? Number(keySpec[2]) : from + 1
      return fields.slice(from, Math.max(from + 1, to)).join(sep ?? ' ')
    }
    const numeric = Boolean(flags.n) || Boolean(keySpec?.[3]?.includes('n'))
    const fold = Boolean(flags.f)
    const norm = (s: string) => {
      let k = flags.b ? s.trimStart() : s
      if (fold) k = k.toLowerCase()
      return k
    }
    const cmp = (a: string, b: string): number => {
      const ka = norm(keyOf(a))
      const kb = norm(keyOf(b))
      let c: number
      if (numeric) c = (parseFloat(ka) || 0) - (parseFloat(kb) || 0)
      else c = ka < kb ? -1 : ka > kb ? 1 : 0
      if (c === 0 && keySpec) c = a < b ? -1 : a > b ? 1 : 0
      return c
    }
    lines.sort(cmp)
    if (flags.r) lines.reverse()
    if (flags.u) lines = lines.filter((l, i) => i === 0 || cmp(lines[i - 1]!, l) !== 0)
    const out = lines.map((l) => l + '\n').join('')
    if (typeof flags.o === 'string') await tiny.writeFile(flags.o, new TextEncoder().encode(out))
    else await tiny.stdout.write(out)
    void decoder
  })
}
