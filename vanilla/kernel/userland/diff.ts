import { main, parseArgs, readAllText, type Pear } from './lib'

type Op = { t: ' ' | '-' | '+'; line: string; a: number; b: number }

/** The edit script turning `a` into `b`, by longest common subsequence (with the common head and tail trimmed first). */
function script(a: string[], b: string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++
  const x = a.slice(head, a.length - tail)
  const y = b.slice(head, b.length - tail)
  const ops: Op[] = []
  for (let i = 0; i < head; i++) ops.push({ t: ' ', line: a[i]!, a: i + 1, b: i + 1 })
  const n = x.length
  const m = y.length
  if (n * m > 25_000_000) throw new Error('files are too different to compare')
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i]![j] = x[i] === y[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) {
      ops.push({ t: ' ', line: x[i]!, a: head + i + 1, b: head + j + 1 })
      i++
      j++
    } else if (i < n && (j === m || dp[i + 1]![j]! >= dp[i]![j + 1]!)) {
      ops.push({ t: '-', line: x[i]!, a: head + i + 1, b: head + j + 1 })
      i++
    } else {
      ops.push({ t: '+', line: y[j]!, a: head + i + 1, b: head + j + 1 })
      j++
    }
  }
  for (let k = 0; k < tail; k++) ops.push({ t: ' ', line: a[a.length - tail + k]!, a: a.length - tail + k + 1, b: b.length - tail + k + 1 })
  return ops
}

const lines = (text: string): string[] => {
  const l = text.split('\n')
  if (l[l.length - 1] === '') l.pop()
  return l
}

export default function (tiny: Pear): Promise<number> {
  return main('diff', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['U'])
    if (rest.length !== 2) {
      await tiny.stderr.write('usage: diff [-u] [-q] file1 file2\n')
      return 2
    }
    const [fa, fb] = rest as [string, string]
    const [ta, tb] = await Promise.all([readAllText(tiny, fa), readAllText(tiny, fb)])
    if (ta === tb) return 0
    if (flags.q) {
      await tiny.stdout.write(`Files ${fa} and ${fb} differ\n`)
      return 1
    }
    const ops = script(lines(ta), lines(tb))
    const ctx = typeof flags.U === 'string' ? Number(flags.U) : 3
    if (flags.u || typeof flags.U === 'string') {
      const stamp = (f: string) => `${f}\t1970-01-01 00:00:00.000000000 +0000`
      let out = `--- ${stamp(fa)}\n+++ ${stamp(fb)}\n`
      const changed = ops.map((o, i) => (o.t !== ' ' ? i : -1)).filter((i) => i >= 0)
      let k = 0
      while (k < changed.length) {
        let start = Math.max(0, changed[k]! - ctx)
        let end = Math.min(ops.length, changed[k]! + ctx + 1)
        while (k + 1 < changed.length && changed[k + 1]! - ctx <= end) {
          k++
          end = Math.min(ops.length, changed[k]! + ctx + 1)
        }
        k++
        const hunk = ops.slice(start, end)
        const aCount = hunk.filter((o) => o.t !== '+').length
        const bCount = hunk.filter((o) => o.t !== '-').length
        const aStart = hunk.find((o) => o.t !== '+')?.a ?? (hunk[0]!.a)
        const bStart = hunk.find((o) => o.t !== '-')?.b ?? (hunk[0]!.b)
        out += `@@ -${aCount ? aStart : aStart - 1}${aCount === 1 ? '' : `,${aCount}`} +${bCount ? bStart : bStart - 1}${bCount === 1 ? '' : `,${bCount}`} @@\n`
        for (const o of hunk) out += `${o.t}${o.line}\n`
        start = end
      }
      await tiny.stdout.write(out)
      return 1
    }
    // the default ("normal") format: 1c1, 2a3, 4d3
    let out = ''
    let i = 0
    while (i < ops.length) {
      if (ops[i]!.t === ' ') {
        i++
        continue
      }
      let j = i
      while (j < ops.length && ops[j]!.t !== ' ') j++
      const chunk = ops.slice(i, j)
      const del = chunk.filter((o) => o.t === '-')
      const add = chunk.filter((o) => o.t === '+')
      const range = (xs: Op[], key: 'a' | 'b', fallback: number) => (xs.length ? (xs.length === 1 ? String(xs[0]![key]) : `${xs[0]![key]},${xs[xs.length - 1]![key]}`) : String(fallback))
      const aPos = chunk[0]!.a
      const bPos = chunk[0]!.b
      const kind = del.length && add.length ? 'c' : del.length ? 'd' : 'a'
      out += `${range(del, 'a', aPos - 1)}${kind}${range(add, 'b', bPos - 1)}\n`
      for (const o of del) out += `< ${o.line}\n`
      if (del.length && add.length) out += '---\n'
      for (const o of add) out += `> ${o.line}\n`
      i = j
    }
    await tiny.stdout.write(out)
    return 1
  })
}
