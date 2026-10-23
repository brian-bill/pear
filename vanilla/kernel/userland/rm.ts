import { eachOperand, main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('rm', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const recursive = Boolean(flags.r || flags.R)
    const force = Boolean(flags.f)
    if (!rest.length) {
      if (force) return 0
      await tiny.stderr.write('usage: rm [-rf] file...\n')
      return 1
    }
    return eachOperand(tiny, 'rm', rest, async (path) => {
      try {
        const st = await tiny.lstat(path)
        if (st.kind === 'dir') {
          if (!recursive) throw new Error('is a directory')
          await tiny.removeAll(path)
        } else await tiny.unlink(path)
      } catch (e) {
        if (!(force && (e as { code?: string }).code === 'ENOENT')) throw e
      }
    })
  })
}
