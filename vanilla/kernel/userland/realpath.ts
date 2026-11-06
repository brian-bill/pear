import { eachOperand, main, absolute, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('realpath', tiny, async () => {
    if (!tiny.args.length) {
      await tiny.stderr.write('usage: realpath file ...\n')
      return 1
    }
    return eachOperand(tiny, 'realpath', tiny.args.filter((a) => !a.startsWith('-')), async (p) => void (await tiny.stdout.write((await tiny.realpath(await absolute(tiny, p))) + '\n')))
  })
}
