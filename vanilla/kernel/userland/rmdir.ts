import { eachOperand, main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('rmdir', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (!rest.length) {
      await tiny.stderr.write('usage: rmdir [-p] directory ...\n')
      return 1
    }
    return eachOperand(tiny, 'rmdir', rest, async (dir) => {
      await tiny.rmdir(dir)
      if (flags.p) for (let d = dir.replace(/\/+$/, ''); d.includes('/'); ) {
        d = d.slice(0, d.lastIndexOf('/'))
        if (!d) break
        await tiny.rmdir(d).catch(() => {})
      }
    })
  })
}
