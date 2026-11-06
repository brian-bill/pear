import { absolute, joinPath, main, parseArgs, readAllBytes, walk, type Pear } from './lib'
import { zipCreate, type ZipEntry } from './archive/core'

export default function (tiny: Pear): Promise<number> {
  return main('zip', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    if (rest.length < 2) {
      await tiny.stderr.write('usage: zip [-rjq] archive.zip file ...\n')
      return 1
    }
    const [archiveArg, ...paths] = rest as [string, ...string[]]
    const archive = archiveArg.endsWith('.zip') ? archiveArg : `${archiveArg}.zip`
    const entries: ZipEntry[] = []
    for (const given of paths) {
      const path = given.replace(/\/+$/, '')
      const st = await tiny.lstat(path)
      const add = async (p: string, s: typeof st) => {
        let name = p.replace(/^\.\//, '').replace(/^\/+/, '')
        if (flags.j) name = name.split('/').pop()!
        if (!name) return
        if (s.kind === 'dir' && flags.j) return
        entries.push({ name, dir: s.kind === 'dir', data: s.kind === 'file' ? await readAllBytes(tiny, p) : new Uint8Array(), mtime: s.mtime, mode: s.mode })
        if (!flags.q) await tiny.stdout.write(`  adding: ${name}${s.kind === 'dir' ? '/' : ''}\n`)
      }
      if (st.kind === 'dir' && flags.r) await walk(tiny, path, add)
      else await add(path, st)
    }
    await tiny.writeFile(await absolute(tiny, archive), await zipCreate(entries))
    void joinPath
    return 0
  })
}
