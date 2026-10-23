import { eachOperand, main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('touch', tiny, async () => {
    if (!tiny.args.length) {
      await tiny.stderr.write('usage: touch file...\n')
      return 1
    }
    return eachOperand(tiny, 'touch', tiny.args, async (path) => {
      if (await tiny.exists(path)) {
        const now = Date.now()
        await tiny.utimes(path, now, now)
      } else await tiny.writeFile(path, new Uint8Array(0))
    })
  })
}
