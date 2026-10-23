import { eachOperand, main, parseArgs, readInput, type Pear } from './lib'

interface Counts {
  lines: number
  words: number
  bytes: number
}

export default function (tiny: Pear): Promise<number> {
  return main('wc', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const none = !flags.l && !flags.w && !flags.c
    const show = { l: none || Boolean(flags.l), w: none || Boolean(flags.w), c: none || Boolean(flags.c) }
    const files = rest.length ? rest : ['-']
    const rows: Array<[Counts, string]> = []
    const total: Counts = { lines: 0, words: 0, bytes: 0 }
    const status = await eachOperand(tiny, 'wc', files, async (path) => {
      const c: Counts = { lines: 0, words: 0, bytes: 0 }
      let inWord = false
      await readInput(tiny, path, async (chunk) => {
        c.bytes += chunk.length
        for (const b of chunk) {
          if (b === 10) c.lines++
          const space = b === 32 || (b >= 9 && b <= 13)
          if (!space && !inWord) c.words++
          inWord = !space
        }
      })
      rows.push([c, rest.length ? path : ''])
      total.lines += c.lines
      total.words += c.words
      total.bytes += c.bytes
    })
    if (rows.length > 1) rows.push([total, 'total'])
    const values = rows.flatMap(([c]) => [c.lines, c.words, c.bytes])
    const width = rows.length === 1 && [show.l, show.w, show.c].filter(Boolean).length === 1 ? 0 : String(Math.max(0, ...values)).length
    for (const [c, label] of rows) {
      const cols = [show.l && c.lines, show.w && c.words, show.c && c.bytes].filter((x): x is number => x !== false).map((n) => String(n).padStart(width))
      await tiny.stdout.write(cols.join(' ') + (label ? ` ${label}` : '') + '\n')
    }
    return status
  })
}
