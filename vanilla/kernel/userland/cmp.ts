import { main, readAllBytes, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('cmp', tiny, async () => {
    const files = tiny.args.filter((a) => a !== '-s')
    const quiet = tiny.args.includes('-s')
    if (files.length < 2) {
      await tiny.stderr.write('usage: cmp [-s] file1 file2\n')
      return 2
    }
    const [a, b] = await Promise.all([readAllBytes(tiny, files[0]!), readAllBytes(tiny, files[1]!)])
    const n = Math.min(a.length, b.length)
    let line = 1
    for (let i = 0; i < n; i++) {
      if (a[i] !== b[i]) {
        if (!quiet) await tiny.stdout.write(`${files[0]} ${files[1]} differ: char ${i + 1}, line ${line}\n`)
        return 1
      }
      if (a[i] === 10) line++
    }
    if (a.length !== b.length) {
      if (!quiet) await tiny.stderr.write(`cmp: EOF on ${a.length < b.length ? files[0] : files[1]}\n`)
      return 1
    }
    return 0
  })
}
