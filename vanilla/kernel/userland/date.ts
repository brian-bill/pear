import { main, parseArgs, type Pear } from './lib'

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const p2 = (n: number) => String(n).padStart(2, '0')

export function formatDate(d: Date, fmt: string, utc: boolean): string {
  const get = {
    Y: utc ? d.getUTCFullYear() : d.getFullYear(), m: (utc ? d.getUTCMonth() : d.getMonth()) + 1, d: utc ? d.getUTCDate() : d.getDate(),
    H: utc ? d.getUTCHours() : d.getHours(), M: utc ? d.getUTCMinutes() : d.getMinutes(), S: utc ? d.getUTCSeconds() : d.getSeconds(), w: utc ? d.getUTCDay() : d.getDay(),
  }
  const offset = utc ? 0 : -d.getTimezoneOffset()
  const tz = utc ? 'UTC' : (/\(([^)]+)\)/.exec(d.toString())?.[1] ?? 'LOCAL').replace(/[a-z ]/g, '') || 'LOCAL'
  const yday = Math.floor((Date.UTC(get.Y, get.m - 1, get.d) - Date.UTC(get.Y, 0, 0)) / 86400000)
  return fmt.replace(/%([a-zA-Z%])/g, (_m, c: string) => {
    switch (c) {
      case 'Y': return String(get.Y)
      case 'y': return p2(get.Y % 100)
      case 'm': return p2(get.m)
      case 'd': return p2(get.d)
      case 'e': return String(get.d).padStart(2, ' ')
      case 'H': return p2(get.H)
      case 'I': return p2(get.H % 12 || 12)
      case 'M': return p2(get.M)
      case 'S': return p2(get.S)
      case 'p': return get.H < 12 ? 'AM' : 'PM'
      case 'a': return DAYS[get.w]!.slice(0, 3)
      case 'A': return DAYS[get.w]!
      case 'b': case 'h': return MONTHS[get.m - 1]!.slice(0, 3)
      case 'B': return MONTHS[get.m - 1]!
      case 'j': return String(yday).padStart(3, '0')
      case 'u': return String(get.w || 7)
      case 'w': return String(get.w)
      case 's': return String(Math.floor(d.getTime() / 1000))
      case 'N': return String(d.getMilliseconds() * 1e6).padStart(9, '0')
      case 'z': return `${offset < 0 ? '-' : '+'}${p2(Math.floor(Math.abs(offset) / 60))}${p2(Math.abs(offset) % 60)}`
      case 'Z': return tz
      case 'T': return `${p2(get.H)}:${p2(get.M)}:${p2(get.S)}`
      case 'R': return `${p2(get.H)}:${p2(get.M)}`
      case 'D': return `${p2(get.m)}/${p2(get.d)}/${p2(get.Y % 100)}`
      case 'F': return `${get.Y}-${p2(get.m)}-${p2(get.d)}`
      case 'n': return '\n'
      case 't': return '\t'
      case '%': return '%'
      default: return `%${c}`
    }
  })
}

export default function (tiny: Pear): Promise<number> {
  return main('date', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args, ['d', 'r'])
    let when = new Date()
    if (typeof flags.d === 'string') {
      const m = /^@(\d+)$/.exec(flags.d)
      when = m ? new Date(Number(m[1]) * 1000) : new Date(flags.d)
      if (Number.isNaN(when.getTime())) {
        await tiny.stderr.write(`date: invalid date '${flags.d}'\n`)
        return 1
      }
    } else if (typeof flags.r === 'string') when = new Date(Number(flags.r) * 1000)
    const fmt = rest.find((a) => a.startsWith('+'))?.slice(1)
    const iso = flags.I ? '%Y-%m-%dT%H:%M:%S%z' : null
    await tiny.stdout.write(formatDate(when, fmt ?? iso ?? '%a %b %e %H:%M:%S %Z %Y', Boolean(flags.u)) + '\n')
  })
}
