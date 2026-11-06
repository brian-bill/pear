import { main, parseArgs, readAllText, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('xargs', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['n', 'I', 'L', 'P', 'd'])
    const cmd = rest.length ? rest : ['echo']
    const input = await readAllText(tiny, '-')
    const replaceMode = typeof flags.I === 'string'
    const items: string[] = replaceMode ? input.split('\n').filter(Boolean) : tiny.args.includes('-0') ? input.split('\0').filter(Boolean) : typeof flags.d === 'string' ? input.split(flags.d).filter(Boolean) : (input.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map((s) => s.replace(/^(["'])(.*)\1$/s, '$2'))
    const batches: string[][] = []
    const replace = typeof flags.I === 'string' ? flags.I : null
    if (replace) for (const i of items) batches.push([i])
    else if (flags.n) for (let i = 0; i < items.length; i += Number(flags.n)) batches.push(items.slice(i, i + Number(flags.n)))
    else batches.push(items)
    if (!items.length) {
      batches.length = 0
      if (!tiny.args.includes('-r')) batches.push([])
    }
    let status = 0
    for (const batch of batches) {
      const argv = replace ? cmd.map((a) => a.split(replace).join(batch[0] ?? '')) : [...cmd, ...batch]
      const pid = await tiny.spawn('/bin/sh', { args: ['-c', 'exec "$@"', 'xargs', ...argv], stdio: { stdin: 'null', stdout: 'inherit', stderr: 'inherit' } })
      const st = await tiny.wait(pid)
      if (st.code !== 0) status = st.code === 255 ? 124 : 123
    }
    return status
  })
}
