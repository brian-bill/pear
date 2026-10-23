import { eachOperand, main, parseArgs, signalName, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('kill', tiny, async () => {
    // `-9` and `-KILL` are signals, not flags: turn them into -s.
    const args = tiny.args.map((a) => (/^-[A-Za-z0-9]+$/.test(a) && a !== '-s' ? `-s${a.slice(1)}` : a))
    const { flags, rest } = parseArgs(args, ['s'])
    const sig = flags.s === undefined ? 'SIGTERM' : signalName(String(flags.s))
    if (!sig) {
      await tiny.stderr.write(`kill: ${flags.s}: invalid signal\n`)
      return 1
    }
    if (!rest.length) {
      await tiny.stderr.write('usage: kill [-SIGNAL] pid...\n')
      return 1
    }
    return eachOperand(tiny, 'kill', rest, (target) => tiny.kill(Number(target), sig as never))
  })
}
