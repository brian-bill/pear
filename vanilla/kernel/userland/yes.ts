import { type Pear } from './lib'

/** Prints its arguments (or "y") forever: ends with SIGPIPE when the reader goes away. */
export default async function (tiny: Pear): Promise<number> {
  const line = (tiny.args.join(' ') || 'y') + '\n'
  const chunk = line.repeat(Math.max(1, Math.floor(4096 / line.length)))
  for (;;) await tiny.stdout.write(chunk)
}
