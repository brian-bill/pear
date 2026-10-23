import { main, parseArgs, transfer, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('cp', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (rest.length < 2) {
      await tiny.stderr.write('usage: cp [-r] source... target\n')
      return 1
    }
    const recursive = Boolean(flags.r || flags.R)
    return transfer(tiny, 'cp', rest, async (src, dest) => {
      if ((await tiny.stat(src)).kind === 'dir' && !recursive) throw new Error('is a directory (use -r)')
      await tiny.copy(src, dest, { recursive })
    })
  })
}
