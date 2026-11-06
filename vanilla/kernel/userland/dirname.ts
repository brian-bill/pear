import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('dirname', tiny, async () => {
    if (!tiny.args.length) {
      await tiny.stderr.write('usage: dirname string ...\n')
      return 1
    }
    for (const name of tiny.args) {
      const t = name.replace(/\/+$/, '')
      const i = t.lastIndexOf('/')
      await tiny.stdout.write((i < 0 ? '.' : i === 0 ? '/' : t.slice(0, i).replace(/\/+$/, '') || '/') + '\n')
    }
  })
}
