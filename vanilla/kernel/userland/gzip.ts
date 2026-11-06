import { eachOperand, main, parseArgs, readAllBytes, type Pear } from './lib'
import { gunzip, gzip, isGzip } from './archive/core'

/** gzip, and (as `gunzip` and `zcat`) its inverse. */
export async function gzipMain(tiny: Pear, name: 'gzip' | 'gunzip' | 'zcat'): Promise<number> {
  return main(name, tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args)
    const decompress = name !== 'gzip' || Boolean(flags.d)
    const toStdout = name === 'zcat' || Boolean(flags.c)
    if (!rest.length) {
      const data = await readAllBytes(tiny, '-')
      await tiny.stdout.write(decompress ? (isGzip(data) ? await gunzip(data) : data) : await gzip(data))
      return 0
    }
    return eachOperand(tiny, name, rest, async (path) => {
      const data = await readAllBytes(tiny, path)
      if (decompress) {
        if (!isGzip(data)) throw new Error('not in gzip format')
        const out = await gunzip(data)
        if (toStdout) return void (await tiny.stdout.write(out))
        const target = path.replace(/\.(gz|tgz)$/, (m) => (m === '.tgz' ? '.tar' : ''))
        if (target === path) throw new Error('unknown suffix -- ignored')
        await tiny.writeFile(target, out)
        if (!flags.k) await tiny.unlink(path)
      } else {
        const out = await gzip(data)
        if (toStdout) return void (await tiny.stdout.write(out))
        await tiny.writeFile(`${path}.gz`, out)
        if (!flags.k) await tiny.unlink(path)
      }
    })
  })
}

export default function (tiny: Pear): Promise<number> {
  return gzipMain(tiny, 'gzip')
}
