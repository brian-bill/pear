import { eachInput, lineCountArgs, main, parseArgs, readAllBytes, readAllText, readInput, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('tail', tiny, async () => {
    const opts = parseArgs(tiny.args.filter((a) => a !== '-f'), ['c', 'n'])
    const follow = tiny.args.includes('-f')
    if (typeof opts.flags.c === 'string') {
      return eachInput(tiny, 'tail', opts.rest.length ? opts.rest : ['-'], async (path) => {
        const all = await readAllBytes(tiny, path)
        await tiny.stdout.write(all.subarray(Math.max(0, all.length - Number(opts.flags.c))))
      })
    }
    if (typeof opts.flags.n === 'string' && opts.flags.n.startsWith('+')) {
      const from = Number(opts.flags.n.slice(1))
      return eachInput(tiny, 'tail', opts.rest.length ? opts.rest : ['-'], async (path) => {
        const lines = (await readAllText(tiny, path)).split('\n')
        const keep = lines.slice(Math.max(0, from - 1))
        await tiny.stdout.write(keep.join('\n'))
      })
    }
    const args = await lineCountArgs(tiny, 'tail')
    if (!args) return 1
    const { count, files } = args
    const status = await eachInput(tiny, 'tail', files, async (path) => {
      const parts: string[] = []
      const dec = new TextDecoder()
      await readInput(tiny, path, async (chunk) => void parts.push(dec.decode(chunk, { stream: true })))
      parts.push(dec.decode())
      const lines = parts.join('').split('\n')
      const endsWithNewline = lines[lines.length - 1] === ''
      if (endsWithNewline) lines.pop()
      const out = count === 0 ? [] : lines.slice(-count)
      if (out.length) await tiny.stdout.write(out.join('\n') + (endsWithNewline ? '\n' : ''))
    })
    // -f: keep printing what is appended to the (last) file until the process is ended
    if (follow && files[0] && files[0] !== '-') {
      const path = files[files.length - 1]!
      let seen = (await tiny.stat(path)).size
      for (;;) {
        await new Promise((r) => setTimeout(r, 250))
        const size = await tiny.stat(path).then((s) => s.size, () => seen)
        if (size < seen) seen = 0
        if (size > seen) {
          const fd = await tiny.open(path, 0)
          try {
            await tiny.lseek(fd, seen, 0)
            await tiny.stdout.write(await tiny.read(fd, size - seen))
          } finally {
            await tiny.close(fd)
          }
          seen = size
        }
      }
    }
    return status
  })
}
