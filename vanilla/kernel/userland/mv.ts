import { main, transfer, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('mv', tiny, async () => {
    if (tiny.args.length < 2) {
      await tiny.stderr.write('usage: mv source... target\n')
      return 1
    }
    return transfer(tiny, 'mv', tiny.args, (src, dest) => tiny.rename(src, dest))
  })
}
