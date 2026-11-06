import { eachOperand, main, parseArgs, type Pear } from './lib'

const modeString = (kind: string, mode: number): string => {
  let out = kind === 'dir' ? 'd' : kind === 'symlink' ? 'l' : '-'
  for (const shift of [6, 3, 0]) {
    const b = (mode >> shift) & 7
    out += (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-')
  }
  return out
}
const iso = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace('Z', ' +0000')

export default function (tiny: Pear): Promise<number> {
  return main('stat', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['c'])
    if (!rest.length) {
      await tiny.stderr.write('usage: stat [-L] [-c format] file ...\n')
      return 1
    }
    return eachOperand(tiny, 'stat', rest, async (path) => {
      const st = await (flags.L ? tiny.stat(path) : tiny.lstat(path))
      const type = st.kind === 'dir' ? 'directory' : st.kind === 'symlink' ? 'symbolic link' : 'regular file'
      if (typeof flags.c === 'string') {
        const out = flags.c.replace(/%([nsaAFugyYiNd%])/g, (_m, c: string) => {
          switch (c) {
            case 'n': return path
            case 's': return String(st.size)
            case 'a': return (st.mode & 0o7777).toString(8)
            case 'A': return modeString(st.kind, st.mode)
            case 'F': return type
            case 'u': return String(st.uid)
            case 'g': return String(st.gid)
            case 'y': return iso(st.mtime)
            case 'Y': return String(Math.floor(st.mtime / 1000))
            case 'i': return String(st.ino)
            case 'N': return `'${path}'`
            default: return '%'
          }
        })
        await tiny.stdout.write(out + '\n')
        return
      }
      await tiny.stdout.write(
        `  File: ${path}\n  Size: ${st.size}\tType: ${type}\nInode: ${st.ino}\tLinks: ${st.nlink}\nAccess: (${(st.mode & 0o7777).toString(8).padStart(4, '0')}/${modeString(st.kind, st.mode)})  Uid: ${st.uid}  Gid: ${st.gid}\n` +
          `Modify: ${iso(st.mtime)}\nChange: ${iso(st.ctime)}\n Birth: ${iso(st.birthtime)}\n`,
      )
    })
  })
}
