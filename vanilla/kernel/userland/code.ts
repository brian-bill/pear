import { absolute, main, type Pear } from './lib'

const CODE = 'org.tiny.code'

/** `code [path ...]`: open Code, with each folder or file given. */
export default function (tiny: Pear): Promise<number> {
  return main('code', tiny, async () => {
    if (!tiny.args.length) {
      await tiny.launchOpen(CODE)
      return
    }
    for (const arg of tiny.args) await tiny.launchOpen(await absolute(tiny, arg), { app: CODE })
  })
}
