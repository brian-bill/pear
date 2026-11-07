import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('help', tiny, async () => {
    const list = await tiny.commandList()
    if (!list.length) {
      await tiny.stdout.write('No commands are registered by apps.\n')
      return 0
    }
    const w = Math.max(...list.map((c) => c.name.length))
    await tiny.stdout.write('Commands from installed apps:\n')
    for (const c of list) await tiny.stdout.write(`  ${c.name.padEnd(w)}  ${c.summary ?? c.bundleName}\n`)
    return 0
  })
}
