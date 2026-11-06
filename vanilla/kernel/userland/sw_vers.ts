import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('sw_vers', tiny, async () => {
    await tiny.stdout.write('ProductName:\t\tPear\nProductVersion:\t\t1.0\nBuildVersion:\t\tVanilla\n')
  })
}
