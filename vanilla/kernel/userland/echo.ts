import { type Pear } from './lib'

export default async function (tiny: Pear): Promise<number> {
  let args = tiny.args
  let newline = true
  while (args[0] === '-n') {
    newline = false
    args = args.slice(1)
  }
  await tiny.stdout.write(args.join(' ') + (newline ? '\n' : ''))
  return 0
}
