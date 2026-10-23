import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('sleep', tiny, async () => {
    const secs = Number(tiny.args[0])
    if (!(secs >= 0)) {
      await tiny.stderr.write('usage: sleep SECONDS\n')
      return 1
    }
    await new Promise((r) => setTimeout(r, secs * 1000))
  })
}
