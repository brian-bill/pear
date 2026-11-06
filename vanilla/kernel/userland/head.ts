import { LineSplitter, eachInput, lineCountArgs, main, parseArgs, readInput, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('head', tiny, async () => {
    const bytes = parseArgs(tiny.args, ['c', 'n'])
    if (typeof bytes.flags.c === 'string') {
      const limit = Number(bytes.flags.c)
      return eachInput(tiny, 'head', bytes.rest.length ? bytes.rest : ['-'], async (path) => {
        let left = limit
        await readInput(tiny, path, async (chunk) => {
          if (left <= 0) return false
          await tiny.stdout.write(chunk.subarray(0, left))
          left -= chunk.length
          if (left <= 0) return false
        })
      })
    }
    const args = await lineCountArgs(tiny, 'head')
    if (!args) return 1
    const { count, files } = args
    return eachInput(tiny, 'head', files, async (path) => {
      if (count === 0) return
      let seen = 0
      const split = new LineSplitter()
      await readInput(tiny, path, async (chunk) => {
        let out = ''
        let done = false
        for (const line of split.push(chunk)) {
          out += line + '\n'
          if (++seen >= count) {
            done = true
            break
          }
        }
        if (out) await tiny.stdout.write(out)
        if (done) return false // stop reading: a writer upstream sees the pipe close
      })
      const last = seen < count ? split.end() : null
      if (last !== null) await tiny.stdout.write(last)
    })
  })
}
