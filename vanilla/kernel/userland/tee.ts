import { main, parseArgs, O, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('tee', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const fds: number[] = []
    let status = 0
    for (const f of rest) {
      try {
        fds.push(await tiny.open(f, O.WRONLY | O.CREAT | (flags.a ? O.APPEND : O.TRUNC)))
      } catch (e) {
        await tiny.stderr.write(`tee: ${f}: ${(e as Error).message}\n`)
        status = 1
      }
    }
    for (let chunk; (chunk = await tiny.stdin.read()); ) {
      await tiny.stdout.write(chunk)
      for (const fd of fds) await tiny.write(fd, chunk)
    }
    for (const fd of fds) await tiny.close(fd)
    return status
  })
}
