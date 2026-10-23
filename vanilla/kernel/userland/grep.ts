import { LineSplitter, eachOperand, joinPath, main, parseArgs, readInput, reason, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('grep', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['e'])
    const pattern = flags.e !== undefined ? String(flags.e) : rest.shift()
    if (pattern === undefined) {
      await tiny.stderr.write('usage: grep [-ivncFlqrE] pattern [file...]\n')
      return 2
    }
    const source = flags.F ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern
    let re: RegExp
    try {
      re = new RegExp(source, flags.i ? 'i' : '')
    } catch (e) {
      await tiny.stderr.write(`grep: bad pattern: ${reason(e)}\n`)
      return 2
    }
    const invert = Boolean(flags.v)
    let files = rest.length ? rest : flags.r ? ['.'] : ['-']
    if (flags.r) {
      const expanded: string[] = []
      const walk = async (path: string) => {
        const st = await tiny.stat(path).catch(() => null)
        if (st?.kind !== 'dir') return void expanded.push(path)
        for (const e of (await tiny.readdir(path)).sort((a, b) => a.name.localeCompare(b.name))) await walk(joinPath(path, e.name))
      }
      for (const f of files) await walk(f)
      files = expanded
    }
    const prefix = files.length > 1 || Boolean(flags.r)
    let matched = false
    const status = await eachOperand(
      tiny,
      'grep',
      files,
      async (path) => {
        if (flags.q && matched) return
        const split = new LineSplitter()
        let lineNo = 0
        let count = 0
        let pending = ''
        const flushOut = async () => {
          if (pending) await tiny.stdout.write(pending)
          pending = ''
        }
        const handle = async (line: string): Promise<boolean> => {
          lineNo++
          if (re.test(line) === invert) return true
          matched = true
          count++
          if (flags.q || flags.l) return false
          if (!flags.c) pending += `${prefix ? `${path}:` : ''}${flags.n ? `${lineNo}:` : ''}${line}\n`
          return true
        }
        let stop = false
        await readInput(tiny, path, async (chunk) => {
          for (const line of split.push(chunk)) if (!(await handle(line))) return (stop = true), false
          await flushOut()
        })
        if (!stop) {
          const last = split.end()
          if (last !== null) await handle(last)
        }
        await flushOut()
        if (flags.l && count) await tiny.stdout.write(`${path}\n`)
        if (flags.c) await tiny.stdout.write(`${prefix ? `${path}:` : ''}${count}\n`)
      },
      2,
    )
    if (flags.q && matched) return 0
    return status || (matched ? 0 : 1)
  })
}
