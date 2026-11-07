import { main, parseArgs, reason, type Pear } from './lib'

const USAGE = 'usage: services [list | start ID|PATH | stop ID | restart ID | enable ID | disable ID | logs ID [-n COUNT]]'

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

export default function (tiny: Pear): Promise<number> {
  return main('services', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['n'])
    const [verb = 'list', id] = rest
    const need = (): string => {
      if (!id) throw new Error(USAGE)
      return id
    }
    const out = (s: string) => tiny.stdout.write(s + '\n')
    switch (verb) {
      case 'list': {
        const rows = await tiny.serviceList()
        const w = Math.max(2, ...rows.map((r) => r.id.length))
        await out(`${pad('ID', w)}  ${pad('STATE', 8)}  ${pad('PID', 6)}  ${pad('RESTARTS', 8)}  AUTOSTART  NOTE`)
        for (const r of rows) {
          await out(`${pad(r.id, w)}  ${pad(r.state, 8)}  ${pad(r.pid === null ? '-' : String(r.pid), 6)}  ${pad(String(r.restarts), 8)}  ${pad(r.enabled ? 'yes' : 'no', 9)}  ${r.reason ?? ''}`)
        }
        return 0
      }
      case 'start': {
        const pid = await tiny.serviceStart(need())
        await out(`started (pid ${pid})`)
        return 0
      }
      case 'stop':
        await tiny.serviceStop(need())
        return 0
      case 'restart': {
        const pid = await tiny.serviceRestart(need())
        await out(`restarted (pid ${pid})`)
        return 0
      }
      case 'enable':
        await tiny.serviceEnable(need())
        return 0
      case 'disable':
        await tiny.serviceDisable(need())
        return 0
      case 'logs': {
        const count = typeof flags.n === 'string' ? parseInt(flags.n, 10) : 50
        const lines = await tiny.serviceLogs(need(), { limit: Number.isFinite(count) && count > 0 ? count : 50 })
        for (const l of lines) await (l.stream === 'stderr' ? tiny.stderr : tiny.stdout).write(l.message + '\n')
        return 0
      }
      default:
        throw new Error(`${verb}: unknown command\n${USAGE}`)
    }
  }).catch(async (e) => {
    await tiny.stderr.write(`services: ${reason(e)}\n`)
    return 1
  })
}
