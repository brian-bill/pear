import { eachOperand, main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('ln', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (!flags.s) {
      await tiny.stderr.write('ln: hard links are not supported; use ln -s\n')
      return 1
    }
    if (!rest.length || rest.length > 2) {
      await tiny.stderr.write('usage: ln -s [-f] target [link]\n')
      return 1
    }
    const [target, link0] = rest as [string, string?]
    let link = link0 ?? target.replace(/\/+$/, '').split('/').pop()!
    if (await tiny.stat(link).then((s) => s.kind === 'dir', () => false)) link = `${link.replace(/\/$/, '')}/${target.replace(/\/+$/, '').split('/').pop()}`
    return eachOperand(tiny, 'ln', [link], async (l) => {
      if (flags.f) await tiny.unlink(l).catch(() => {})
      await tiny.symlink(target, l)
    })
  })
}
