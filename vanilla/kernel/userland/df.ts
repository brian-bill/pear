import { main, parseArgs, type Pear } from './lib'

const human = (n: number): string => {
  const units = ['B', 'K', 'M', 'G', 'T']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return i === 0 ? String(n) : `${v < 10 ? v.toFixed(1) : Math.round(v)}${units[i]}`
}

export default function (tiny: Pear): Promise<number> {
  return main('df', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const fmt = (n: number) => (flags.h ? human(n) : String(Math.ceil(n / 1024)))
    const rows = [['Filesystem', flags.h ? 'Size' : '1K-blocks', 'Used', 'Available', 'Use%', 'Mounted on']]
    for (const p of rest.length ? rest : ['/']) {
      const s = await tiny.statfs()
      const total = s.total ?? s.used
      const free = s.free ?? Math.max(0, total - s.used)
      rows.push(['vanilla', fmt(total), fmt(s.used), fmt(free), total ? `${Math.round((s.used / total) * 100)}%` : '-', p])
    }
    const widths = rows[0]!.map((_h, i) => Math.max(...rows.map((r) => r[i]!.length)))
    for (const r of rows) await tiny.stdout.write(r.map((c, i) => (i === 0 || i === 5 ? c.padEnd(widths[i]!) : c.padStart(widths[i]!))).join(' ').trimEnd() + '\n')
  })
}
