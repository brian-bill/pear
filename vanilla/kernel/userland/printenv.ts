import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('printenv', tiny, async () => {
    const env = await tiny.environ()
    if (!tiny.args.length) {
      await tiny.stdout.write(Object.entries(env).map(([k, v]) => `${k}=${v}\n`).join(''))
      return 0
    }
    let status = 0
    for (const n of tiny.args) {
      if (env[n] === undefined) status = 1
      else await tiny.stdout.write(env[n] + '\n')
    }
    return status
  })
}
