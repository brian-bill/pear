import { eachInput, lineCountArgs, main, readInput, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('tail', tiny, async () => {
    const args = await lineCountArgs(tiny, 'tail')
    if (!args) return 1
    const { count, files } = args
    return eachInput(tiny, 'tail', files, async (path) => {
      const parts: string[] = []
      const dec = new TextDecoder()
      await readInput(tiny, path, async (chunk) => void parts.push(dec.decode(chunk, { stream: true })))
      parts.push(dec.decode())
      const lines = parts.join('').split('\n')
      const endsWithNewline = lines[lines.length - 1] === ''
      if (endsWithNewline) lines.pop()
      const out = count === 0 ? [] : lines.slice(-count)
      if (out.length) await tiny.stdout.write(out.join('\n') + (endsWithNewline ? '\n' : ''))
    })
  })
}
