import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('basename', tiny, async () => {
    const [name, suffix] = tiny.args
    if (name === undefined) {
      await tiny.stderr.write('usage: basename string [suffix]\n')
      return 1
    }
    let base = name.replace(/\/+$/, '').split('/').pop() || (name.startsWith('/') ? '/' : '')
    if (suffix && base !== suffix && base.endsWith(suffix)) base = base.slice(0, -suffix.length)
    await tiny.stdout.write(base + '\n')
  })
}
