import { absolute, main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('open', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['a'])
    if (!rest.length) {
      await tiny.stderr.write('usage: open [-a app-id] file-or-url ...\n')
      return 1
    }
    for (const target of rest) {
      const t = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : await absolute(tiny, target)
      await tiny.launchOpen(t, typeof flags.a === 'string' ? { app: flags.a } : undefined)
    }
  })
}
