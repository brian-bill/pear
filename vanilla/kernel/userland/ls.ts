import { joinPath, main, parseArgs, reason, type Pear } from './lib'

const pad = (s: string | number, n: number, left = false) => (left ? String(s).padEnd(n) : String(s).padStart(n))

function modeString(kind: string, mode: number): string {
  const type = kind === 'dir' ? 'd' : kind === 'symlink' ? 'l' : '-'
  let out = type
  for (const shift of [6, 3, 0]) {
    const bits = (mode >> shift) & 7
    out += (bits & 4 ? 'r' : '-') + (bits & 2 ? 'w' : '-') + (bits & 1 ? 'x' : '-')
  }
  return out
}

function when(ms: number): string {
  const d = new Date(ms)
  const month = d.toLocaleString('en-US', { month: 'short' })
  const recent = Date.now() - ms < 180 * 24 * 3600 * 1000
  const time = recent ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ` ${d.getFullYear()}`
  return `${month} ${pad(d.getDate(), 2)} ${time}`
}

export default function (tiny: Pear): Promise<number> {
  return main('ls', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const long = Boolean(flags.l)
    const all = Boolean(flags.a)
    const targets = rest.length ? rest : ['.']
    let status = 0

    interface Entry {
      name: string
      kind: string
      mode: number
      nlink: number
      uid: number
      gid: number
      size: number
      mtime: number
      link?: string
    }
    const describe = async (path: string, name: string): Promise<Entry> => {
      const st = await tiny.lstat(path)
      const e: Entry = { name, kind: st.kind, mode: st.mode, nlink: st.nlink, uid: st.uid, gid: st.gid, size: st.size, mtime: st.mtime }
      if (st.kind === 'symlink') e.link = await tiny.readlink(path).catch(() => '?')
      return e
    }

    const print = async (entries: Entry[]) => {
      if (long) {
        const w = (f: (e: Entry) => string | number) => Math.max(0, ...entries.map((e) => String(f(e)).length))
        const [wn, wu, wg, ws] = [w((e) => e.nlink), w((e) => e.uid), w((e) => e.gid), w((e) => e.size)]
        for (const e of entries) {
          const name = e.link !== undefined ? `${e.name} -> ${e.link}` : e.name
          await tiny.stdout.write(`${modeString(e.kind, e.mode)} ${pad(e.nlink, wn)} ${pad(e.uid, wu)} ${pad(e.gid, wg)} ${pad(e.size, ws)} ${when(e.mtime)} ${name}\n`)
        }
      } else if (tiny.stdout.isTTY && !flags[1]) {
        const size = await tiny.getwinsize().catch(() => ({ cols: 80, rows: 24 }))
        const names = entries.map((e) => e.name)
        const colWidth = Math.max(0, ...names.map((n) => n.length)) + 2
        const perRow = Math.max(1, Math.floor(size.cols / colWidth))
        const rows = Math.ceil(names.length / perRow)
        for (let r = 0; r < rows; r++) {
          let line = ''
          for (let c = 0; c < perRow; c++) {
            const n = names[c * rows + r]
            if (n !== undefined) line += n.padEnd(colWidth)
          }
          await tiny.stdout.write(line.trimEnd() + '\n')
        }
      } else {
        for (const e of entries) await tiny.stdout.write(e.name + '\n')
      }
    }

    const files: Entry[] = []
    const dirs: string[] = []
    for (const t of targets) {
      try {
        const st = await tiny.stat(t)
        if (st.kind === 'dir' && !flags.d) dirs.push(t)
        else files.push(await describe(t, t))
      } catch (e) {
        await tiny.stderr.write(`ls: cannot access '${t}': ${reason(e)}\n`)
        status = 1
      }
    }
    files.sort((a, b) => a.name.localeCompare(b.name))
    if (files.length) await print(files)
    for (const [k, dir] of dirs.sort().entries()) {
      try {
        if (targets.length > 1) await tiny.stdout.write(`${files.length || k ? '\n' : ''}${dir}:\n`)
        const names = (await tiny.readdir(dir)).map((e) => e.name)
        if (all) names.push('.', '..')
        names.sort((a, b) => a.localeCompare(b))
        const entries: Entry[] = []
        for (const name of names) {
          if (!all && name.startsWith('.')) continue
          entries.push(await describe(joinPath(dir, name), name).catch(() => ({ name, kind: 'file', mode: 0, nlink: 1, uid: 0, gid: 0, size: 0, mtime: 0 })))
        }
        if (long) await tiny.stdout.write(`total ${entries.length}\n`)
        await print(entries)
      } catch (e) {
        await tiny.stderr.write(`ls: cannot open directory '${dir}': ${reason(e)}\n`)
        status = 1
      }
    }
    return status
  })
}
