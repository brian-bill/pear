import { absolute, joinPath, main, parseArgs, readAllBytes, type Pear } from './lib'
import { crc32, zipList } from './archive/core'

export default function (tiny: Pear): Promise<number> {
  return main('unzip', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['d'])
    const [archive, ...members] = rest
    if (!archive) {
      await tiny.stderr.write('usage: unzip [-lptoq] [-d dir] archive.zip [member ...]\n')
      return 1
    }
    const items = zipList(await readAllBytes(tiny, await absolute(tiny, archive)))
    const wanted = items.filter((i) => !members.length || members.some((m) => i.name === m || i.name.startsWith(m.replace(/\/$/, '') + '/')))
    if (flags.l) {
      await tiny.stdout.write('  Length      Date    Time    Name\n---------  ---------- -----   ----\n')
      let total = 0
      for (const i of wanted) {
        total += i.size
        const d = new Date(i.mtime)
        await tiny.stdout.write(`${String(i.size).padStart(9)}  ${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)}   ${i.name}\n`)
      }
      await tiny.stdout.write(`---------                     -------\n${String(total).padStart(9)}                     ${wanted.length} files\n`)
      return 0
    }
    const root = typeof flags.d === 'string' ? flags.d : '.'
    let status = 0
    for (const i of wanted) {
      if (i.name.split('/').includes('..') || i.name.startsWith('/')) {
        await tiny.stderr.write(`unzip: skipping unsafe name ${i.name}\n`)
        status = 1
        continue
      }
      const target = joinPath(root, i.name.replace(/\/$/, ''))
      try {
        if (i.dir) {
          if (!flags.t && !flags.p) await tiny.mkdir(target, { recursive: true })
          continue
        }
        const data = await i.read()
        if (flags.t) {
          if (crc32(data) === undefined) throw new Error('bad data')
          continue
        }
        if (flags.p) {
          await tiny.stdout.write(data)
          continue
        }
        await tiny.mkdir(target.slice(0, target.lastIndexOf('/')) || '/', { recursive: true })
        if (!flags.o && (await tiny.exists(target))) {
          await tiny.stderr.write(`unzip: ${target} exists (use -o to overwrite)\n`)
          status = 1
          continue
        }
        await tiny.writeFile(target, data)
        await tiny.chmod(target, i.mode).catch(() => {})
        if (!flags.q) await tiny.stdout.write(`  inflating: ${i.name}\n`)
      } catch (e) {
        await tiny.stderr.write(`unzip: ${i.name}: ${(e as Error).message}\n`)
        status = 1
      }
    }
    return status
  })
}
