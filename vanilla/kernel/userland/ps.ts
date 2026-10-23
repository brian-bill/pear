import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('ps', tiny, async () => {
    const list = (await tiny.list()).sort((a, b) => a.pid - b.pid)
    const pad = (v: unknown, n: number) => String(v).padStart(n)
    await tiny.stdout.write(`${pad('PID', 5)} ${pad('PPID', 5)} ${pad('PGID', 5)} ${'STATE'.padEnd(8)} COMMAND\n`)
    for (const p of list) {
      const state = p.state === 'zombie' ? 'zombie' : p.unresponsive ? 'hung' : 'running'
      await tiny.stdout.write(`${pad(p.pid, 5)} ${pad(p.ppid, 5)} ${pad(p.pgid, 5)} ${state.padEnd(8)} ${[p.name, ...p.args].join(' ')}\n`)
    }
  })
}
