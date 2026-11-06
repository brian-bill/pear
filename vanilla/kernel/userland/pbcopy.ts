import { concatBytes, decoder, main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('pbcopy', tiny, async () => {
    const parts: Uint8Array[] = []
    for (let c; (c = await tiny.stdin.read()); ) parts.push(c)
    const port = await tiny.lookup('tiny.clipboard')
    const reply = (await tiny.request(port, { op: 'write', items: [{ type: 'public.utf8-plain-text', data: decoder.decode(concatBytes(parts)) }] })).data as { error?: string } | undefined
    if (reply?.error) throw new Error(reply.error)
  })
}
