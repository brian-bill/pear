import { main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('which', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const dirs = ((await tiny.environ()).PATH ?? '/bin').split(':')
    let status = 0
    for (const name of rest) {
      let found = false
      for (const dir of name.includes('/') ? [''] : dirs) {
        const p = name.includes('/') ? name : `${dir.replace(/\/$/, '')}/${name}`
        if (await tiny.stat(p).then((s) => s.kind === 'file', () => false)) {
          // -v: say who the command belongs to, when an app registered it
          const owner = flags.v && !name.includes('/') ? await tiny.commandResolve(name).catch(() => null) : null
          const who = owner ? `\t${owner.bundleName} (${owner.bundleId})${owner.owner.kind === 'link' ? ' [development link]' : ''}${owner.summary ? ` - ${owner.summary}` : ''}` : ''
          await tiny.stdout.write(p + who + '\n')
          found = true
          if (!flags.a) break
        }
      }
      if (!found) status = 1
    }
    return status
  })
}
