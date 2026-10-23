import { eachOperand, main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('mkdir', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (!rest.length) {
      await tiny.stderr.write('usage: mkdir [-p] directory...\n')
      return 1
    }
    return eachOperand(tiny, 'mkdir', rest, (path) => tiny.mkdir(path, { recursive: Boolean(flags.p) }))
  })
}
