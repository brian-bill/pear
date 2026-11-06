import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('hostname', tiny, async () => {
    await tiny.stdout.write(((await tiny.environ()).HOSTNAME ?? 'pear.local') + '\n')
  })
}
