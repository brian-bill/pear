import { joinPath, main, parseArgs, reason, type Pear } from './lib'

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
  return main('du', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['d', 'B'])
    const maxDepth = typeof flags.d === 'string' ? Number(flags.d) : Infinity
    const show = (bytes: number) => (flags.h ? human(bytes) : String(Math.ceil(bytes / 1024)))
    let status = 0
    let total = 0
    const measure = async (path: string, depth: number, top: boolean): Promise<number> => {
      let st
      try {
        st = await tiny.lstat(path)
      } catch (e) {
        await tiny.stderr.write(`du: ${path}: ${reason(e)}\n`)
        status = 1
        return 0
      }
      let size = st.size
      if (st.kind === 'dir') {
        for (const e of (await tiny.readdir(path).catch(() => [])).sort((a, b) => (a.name < b.name ? -1 : 1))) size += await measure(joinPath(path, e.name), depth + 1, false)
      }
      const print = flags.s ? top : depth <= maxDepth && (st.kind === 'dir' || Boolean(flags.a) || top)
      if (print) await tiny.stdout.write(`${show(size)}\t${path}\n`)
      return size
    }
    for (const p of rest.length ? rest : ['.']) total += await measure(p, 0, true)
    if (flags.c) await tiny.stdout.write(`${show(total)}\ttotal\n`)
    return status
  })
}
