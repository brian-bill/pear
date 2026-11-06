import { eachInput, LineSplitter, main, parseArgs, readInput, type Pear } from './lib'

/** `1,3-5,7-` as a test on a 1-based position. */
function ranges(spec: string): (n: number) => boolean {
  const parts = spec.split(',').map((p) => {
    const m = /^(\d*)-(\d*)$/.exec(p)
    if (m) return [m[1] ? Number(m[1]) : 1, m[2] ? Number(m[2]) : Infinity] as const
    return [Number(p), Number(p)] as const
  })
  return (n) => parts.some(([a, b]) => n >= a && n <= b)
}

export default function (tiny: Pear): Promise<number> {
  return main('cut', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['d', 'f', 'c', 'b'])
    const spec = (flags.f ?? flags.c ?? flags.b) as string | undefined
    if (typeof spec !== 'string') {
      await tiny.stderr.write('usage: cut -f list [-d delim] | -c list [file ...]\n')
      return 1
    }
    const keep = ranges(spec)
    const delim = typeof flags.d === 'string' ? flags.d : '\t'
    const cut = (line: string): string | null => {
      if (flags.f) {
        if (!line.includes(delim)) return flags.s ? null : line
        return line.split(delim).filter((_f, i) => keep(i + 1)).join(delim)
      }
      return [...line].filter((_c, i) => keep(i + 1)).join('')
    }
    return eachInput(tiny, 'cut', rest.length ? rest : ['-'], async (path) => {
      const split = new LineSplitter()
      const emit = async (lines: string[]) => {
        let out = ''
        for (const l of lines) {
          const c = cut(l)
          if (c !== null) out += c + '\n'
        }
        if (out) await tiny.stdout.write(out)
      }
      await readInput(tiny, path, async (chunk) => emit(split.push(chunk)))
      const last = split.end()
      if (last !== null) await emit([last])
    })
  })
}
