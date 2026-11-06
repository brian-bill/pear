import { main, parseArgs, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('seq', tiny, async () => {
    const { flags, rest } = parseArgs(tiny.args.map((a) => (/^-\d/.test(a) ? ` ${a}` : a)), ['s', 'f'])
    const nums = rest.map(Number)
    if (!nums.length || nums.length > 3 || nums.some(Number.isNaN)) {
      await tiny.stderr.write('usage: seq [-w] [-s sep] [first [incr]] last\n')
      return 1
    }
    const [first, incr, last] = nums.length === 1 ? [1, 1, nums[0]!] : nums.length === 2 ? [nums[0]!, 1, nums[1]!] : (nums as [number, number, number]).slice(0, 3).length ? [nums[0]!, nums[1]!, nums[2]!] : [1, 1, 1]
    if (incr === 0) return 1
    const decimals = Math.max(...rest.map((r) => (r.split('.')[1] ?? '').length))
    const items: string[] = []
    for (let n = first; incr > 0 ? n <= last + 1e-9 : n >= last - 1e-9; n += incr) items.push(decimals ? n.toFixed(decimals) : String(n))
    const width = flags.w ? Math.max(...items.map((i) => i.length)) : 0
    const sep = typeof flags.s === 'string' ? flags.s : '\n'
    await tiny.stdout.write(items.map((i) => i.padStart(width, '0')).join(sep) + '\n')
  })
}
