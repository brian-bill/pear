import { eachOperand, main, readInput, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('cat', tiny, () =>
    eachOperand(tiny, 'cat', tiny.args.length ? tiny.args : ['-'], (path) => readInput(tiny, path, (chunk) => tiny.stdout.write(chunk))),
  )
}
