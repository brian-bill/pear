import { main, parseArgs, readAllText, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('uniq', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const text = await readAllText(tiny, rest[0] ?? '-')
    const lines = text.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const groups: Array<[string, number]> = []
    const same = (a: string, b: string) => (flags.i ? a.toLowerCase() === b.toLowerCase() : a === b)
    for (const l of lines) {
      const last = groups[groups.length - 1]
      if (last && same(last[0], l)) last[1]++
      else groups.push([l, 1])
    }
    let out = ''
    for (const [l, n] of groups) {
      if (flags.d && n < 2) continue
      if (flags.u && n > 1) continue
      out += (flags.c ? `${String(n).padStart(4)} ` : '') + l + '\n'
    }
    if (rest[1]) await tiny.writeFile(rest[1], new TextEncoder().encode(out))
    else await tiny.stdout.write(out)
  })
}
