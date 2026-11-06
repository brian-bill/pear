import { absolute, joinPath, main, readAllBytes, walk, type Pear } from './lib'
import { gunzip, gzip, isGzip, tarCreate, tarParse, type TarEntry } from './archive/core'

const modeString = (kind: string, mode: number): string => {
  let out = kind === 'dir' ? 'd' : kind === 'symlink' ? 'l' : '-'
  for (const shift of [6, 3, 0]) {
    const b = (mode >> shift) & 7
    out += (b & 4 ? 'r' : '-') + (b & 2 ? 'w' : '-') + (b & 1 ? 'x' : '-')
  }
  return out
}

export default function (tiny: Pear): Promise<number> {
  return main('tar', tiny, async () => {
    const argv = [...tiny.args]
    let modeFlags = ''
    let archive: string | null = null
    let dir: string | null = null
    let strip = 0
    const names: string[] = []
    // the first word may be old-style flags without a dash: `tar czf out.tgz dir`
    const takeArg = (): string => {
      const v = argv.shift()
      if (v === undefined) throw new Error('option requires an argument')
      return v
    }
    if (argv[0] && !argv[0].startsWith('-') && /^[cxtvzfCkOpP]+$/.test(argv[0])) argv[0] = `-${argv[0]}`
    while (argv.length) {
      const a = argv.shift()!
      if (a.startsWith('--strip-components')) strip = Number(a.includes('=') ? a.split('=')[1] : takeArg())
      else if (a === '--') names.push(...argv.splice(0))
      else if (a.startsWith('--')) {
        const long: Record<string, string> = { '--create': 'c', '--extract': 'x', '--list': 't', '--verbose': 'v', '--gzip': 'z', '--file': 'f', '--directory': 'C' }
        const f = long[a.split('=')[0]!]
        if (!f) throw new Error(`unrecognized option '${a}'`)
        modeFlags += f
        if (f === 'f') archive = a.includes('=') ? a.split('=')[1]! : takeArg()
        if (f === 'C') dir = a.includes('=') ? a.split('=')[1]! : takeArg()
      } else if (a.startsWith('-') && a.length > 1) {
        for (const f of a.slice(1)) {
          if (f === 'f') archive = takeArg()
          else if (f === 'C') dir = takeArg()
          else modeFlags += f
        }
      } else names.push(a)
    }
    const has = (f: string) => modeFlags.includes(f)
    const verbose = has('v')
    const say = (s: string) => tiny.stdout.write(s + '\n')
    const root = dir ?? '.'

    if (has('c')) {
      if (!names.length) {
        await tiny.stderr.write('tar: no files given to archive\n')
        return 1
      }
      const entries: TarEntry[] = []
      for (const given of names) {
        const path = given === '.' ? '.' : given.replace(/\/+$/, '')
        const base = dir ? joinPath(dir, path) : path
        await walk(tiny, base, async (p, st) => {
          const rel = dir ? p.slice(dir.replace(/\/$/, '').length + 1) : p
          const name = rel.replace(/^\.\//, '').replace(/^\/+/, '')
          if (!name) return
          const e: TarEntry = { name, kind: st.kind, mode: st.mode, uid: st.uid, gid: st.gid, mtime: st.mtime, size: st.size }
          if (st.kind === 'file') e.data = await readAllBytes(tiny, p)
          if (st.kind === 'symlink') e.link = await tiny.readlink(p)
          entries.push(e)
          if (verbose) await tiny.stderr.write(`a ${name}\n`)
        })
      }
      let out = tarCreate(entries)
      if (has('z')) out = await gzip(out)
      if (archive && archive !== '-') await tiny.writeFile(await absolute(tiny, archive), out)
      else await tiny.stdout.write(out)
      return 0
    }

    let data = await readAllBytes(tiny, archive ?? '-')
    if (isGzip(data)) data = await gunzip(data)
    const entries = tarParse(data)
    const wanted = (n: string) => !names.length || names.some((w) => n === w || n.startsWith(`${w.replace(/\/$/, '')}/`))
    if (has('t')) {
      for (const e of entries) {
        if (!wanted(e.name)) continue
        if (verbose) await say(`${modeString(e.kind, e.mode)} ${e.uid}/${e.gid} ${String(e.size).padStart(8)} ${new Date(e.mtime).toISOString().slice(0, 16).replace('T', ' ')} ${e.name}${e.kind === 'dir' ? '/' : ''}${e.link ? ` -> ${e.link}` : ''}`)
        else await say(e.name + (e.kind === 'dir' ? '/' : ''))
      }
      return 0
    }
    if (has('x')) {
      let status = 0
      for (const e of entries) {
        if (!wanted(e.name)) continue
        let name = e.name.replace(/^\/+/, '')
        if (strip) {
          const parts = name.split('/')
          if (parts.length <= strip) continue
          name = parts.slice(strip).join('/')
        }
        if (name.split('/').includes('..')) {
          await tiny.stderr.write(`tar: ${e.name}: refusing to extract outside the target\n`)
          status = 1
          continue
        }
        const target = joinPath(root, name)
        try {
          if (has('O')) {
            if (e.data) await tiny.stdout.write(e.data)
            continue
          }
          if (e.kind === 'dir') await tiny.mkdir(target, { recursive: true })
          else {
            await tiny.mkdir(target.slice(0, target.lastIndexOf('/')) || '/', { recursive: true })
            if (e.kind === 'symlink') {
              await tiny.unlink(target).catch(() => {})
              await tiny.symlink(e.link!, target)
            } else {
              if (has('k') && (await tiny.exists(target))) continue
              await tiny.writeFile(target, e.data ?? new Uint8Array())
            }
          }
          if (e.kind !== 'symlink') {
            await tiny.chmod(target, e.mode & 0o7777)
            if (!has('m')) await tiny.utimes(target, e.mtime, e.mtime).catch(() => {})
          }
          if (verbose) await tiny.stderr.write(`x ${name}\n`)
        } catch (err) {
          await tiny.stderr.write(`tar: ${name}: ${(err as Error).message}\n`)
          status = 1
        }
      }
      return status
    }
    await tiny.stderr.write('usage: tar -c|-x|-t [-vz] [-f archive] [-C dir] [--strip-components=N] [file ...]\n')
    return 1
  })
}
