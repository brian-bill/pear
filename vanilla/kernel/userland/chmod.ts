import { eachOperand, main, parseArgs, walk, type Pear } from './lib'

/** `755`, `u+x`, `go-w`, `a=r`, `u=rwx,g=rx`: the new mode. */
function newMode(spec: string, old: number, isDir: boolean): number | null {
  if (/^[0-7]{1,4}$/.test(spec)) return parseInt(spec, 8)
  let mode = old & 0o7777
  for (const clause of spec.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause)
    if (!m) return null
    const who = m[1] || 'a'
    let bits = 0
    for (const p of m[3]!) {
      const v = p === 'r' ? 4 : p === 'w' ? 2 : p === 'x' || (p === 'X' && (isDir || old & 0o111)) ? 1 : 0
      for (const [i, shift] of [6, 3, 0].entries()) {
        const target = 'ugo'[i]!
        if (who.includes('a') || who.includes(target)) bits |= v << shift
      }
    }
    let mask = 0
    for (const [i, shift] of [6, 3, 0].entries()) if (who.includes('a') || who.includes('ugo'[i]!)) mask |= 7 << shift
    if (m[2] === '+') mode |= bits
    else if (m[2] === '-') mode &= ~bits
    else mode = (mode & ~mask) | bits
  }
  return mode
}

export default function (tiny: Pear): Promise<number> {
  return main('chmod', tiny, async () => {
    const args = tiny.args.filter((a) => !(a.startsWith('-') && /^-[A-Za-z]+$/.test(a) && !/^-[rwxXst]/.test(a)))
    const { flags } = parseArgs(tiny.args.filter((a) => /^-[RfvHLP]+$/.test(a)))
    const [spec, ...files] = args
    if (!spec || !files.length) {
      await tiny.stderr.write('usage: chmod [-R] mode file ...\n')
      return 1
    }
    return eachOperand(tiny, 'chmod', files, async (path) => {
      const apply = async (p: string) => {
        const st = await tiny.stat(p)
        const mode = newMode(spec, st.mode, st.kind === 'dir')
        if (mode === null) throw new Error(`invalid mode: '${spec}'`)
        await tiny.chmod(p, mode)
      }
      if (flags.R) await walk(tiny, path, async (p) => void (await apply(p)))
      else await apply(path)
    })
  })
}
