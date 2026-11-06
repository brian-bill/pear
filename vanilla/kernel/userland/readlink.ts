import { eachOperand, main, parseArgs, absolute, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('readlink', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (!rest.length) {
      await tiny.stderr.write('usage: readlink [-f] file ...\n')
      return 1
    }
    return eachOperand(tiny, 'readlink', rest, async (p) => {
      const out = flags.f ? await tiny.realpath(await absolute(tiny, p)) : await tiny.readlink(p)
      await tiny.stdout.write(out + '\n')
    })
  })
}
