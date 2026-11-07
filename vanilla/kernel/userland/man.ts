import { decoder, main, parseArgs, type Pear } from './lib'

/** The manual for a command: its `man` file, a page made from its `summary`, or a page under /usr/share/man. */
export default function (tiny: Pear): Promise<number> {
  return main('man', tiny, async () => {
    const { rest } = parseArgs(tiny.args)
    if (!rest.length) throw new Error('what manual page do you want?')
    let status = 0
    for (const name of rest) {
      const cmd = await tiny.commandResolve(name)
      if (cmd?.man) {
        await tiny.stdout.write(decoder.decode(await tiny.readFile(cmd.man)))
        continue
      }
      if (cmd) {
        const where = cmd.owner.kind === 'bundle' ? `${cmd.bundleName} (${cmd.bundleId})` : cmd.owner.kind === 'link' ? `${cmd.bundleName}, linked from ${cmd.owner.path}` : `the ${cmd.owner.name} runtime`
        await tiny.stdout.write(`NAME\n    ${name}${cmd.summary ? ` - ${cmd.summary}` : ''}\n\nPROVIDED BY\n    ${where}\n`)
        continue
      }
      let found = false
      for (const dir of ['/usr/share/man', '/usr/local/share/man']) {
        for (const file of [name, `${name}.1`, `man1/${name}.1`]) {
          const text = await tiny.readFile(`${dir}/${file}`).then((b) => decoder.decode(b), () => null)
          if (text !== null) {
            await tiny.stdout.write(text)
            found = true
            break
          }
        }
        if (found) break
      }
      if (!found) {
        await tiny.stderr.write(`No manual entry for ${name}\n`)
        status = 1
      }
    }
    return status
  })
}
