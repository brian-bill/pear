import { type Pear } from './lib'

export default async function (tiny: Pear): Promise<number> {
  const env = await tiny.environ()
  for (const k of Object.keys(env).sort()) await tiny.stdout.write(`${k}=${env[k]}\n`)
  return 0
}
