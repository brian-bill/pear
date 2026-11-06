import { main, type Pear } from './lib'

export default function (tiny: Pear): Promise<number> {
  return main('pbpaste', tiny, async () => {
    const port = await tiny.lookup('tiny.clipboard')
    const reply = (await tiny.request(port, { op: 'read', types: ['public.utf8-plain-text'] })).data as { items?: Array<{ data: unknown }>; error?: string } | undefined
    if (reply?.error) throw new Error(reply.error)
    const d = reply?.items?.[0]?.data
    if (typeof d === 'string') await tiny.stdout.write(d)
    else if (d instanceof Uint8Array) await tiny.stdout.write(d)
  })
}
