import { decoder, main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('uptime', tiny, async () => {
    const boot = Number(decoder.decode(await tiny.readFile('/var/db/.session').catch(() => new Uint8Array())).trim()) || Date.now()
    const secs = Math.max(0, Math.floor((Date.now() - boot) / 1000))
    const d = Math.floor(secs / 86400)
    const h = Math.floor((secs % 86400) / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const t = new Date()
    const clock = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}`
    await tiny.stdout.write(` ${clock} up ${d ? `${d} day${d > 1 ? 's' : ''}, ` : ''}${h}:${String(m).padStart(2, '0')}\n`)
  })
}
