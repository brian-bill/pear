import { main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('mktemp', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['p'])
    const template = rest[0] ?? 'tmp.XXXXXXXXXX'
    const dir = typeof flags.p === 'string' ? flags.p : rest[0]?.includes('/') ? '' : ((await tiny.environ()).TMPDIR ?? '/tmp')
    const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    for (let tries = 0; tries < 20; tries++) {
      const name = template.replace(/X+$/, (x) => Array.from({ length: x.length }, () => chars[Math.floor(Math.random() * chars.length)]).join(''))
      const path = dir ? `${dir.replace(/\/$/, '')}/${name}` : name
      if (await tiny.exists(path)) continue
      if (flags.d) await tiny.mkdir(path, { mode: 0o700 })
      else {
        await tiny.writeFile(path, new Uint8Array())
        await tiny.chmod(path, 0o600)
      }
      await tiny.stdout.write(path + '\n')
      return 0
    }
    await tiny.stderr.write('mktemp: could not create a unique name\n')
    return 1
  })
}
