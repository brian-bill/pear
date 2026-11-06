import { main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('uname', tiny, async () => {
    const { flags } = parseArgs(tiny.args)
    const env = await tiny.environ()
    const parts: Record<string, string> = { s: 'Vanilla', n: env.HOSTNAME ?? 'pear.local', r: '1.0', v: 'Vanilla Kernel Version 1.0', m: 'wasm32' }
    const order = ['s', 'n', 'r', 'v', 'm']
    const wanted = flags.a ? order : order.filter((k) => flags[k])
    await tiny.stdout.write((wanted.length ? wanted : ['s']).map((k) => parts[k]).join(' ') + '\n')
  })
}
