import { gzipMain } from './gzip'
import type { Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return gzipMain(tiny, 'gunzip')
}
