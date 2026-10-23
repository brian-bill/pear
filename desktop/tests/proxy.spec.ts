import { createServer } from 'node:http'
import { expect, test } from '@playwright/test'
import { isPrivateHost, proxy } from '../server/proxy'

/** The deployment's `/api/proxy` (`server/proxy.ts`): a stateless fallback for browser-blocked reads. */

const marked = (url: string, init?: RequestInit) =>
  new Request(`https://pear.test/api/proxy?url=${encodeURIComponent(url)}`, {
    ...init,
    headers: { 'x-tiny-proxy': '1', ...(init?.headers as Record<string, string> | undefined) },
  })

test('only marked requests for http(s) targets are accepted', async () => {
  const unmarked = await proxy(new Request('https://pear.test/api/proxy?url=https%3A%2F%2Fexample.com'))
  expect(unmarked.status).toBe(403)

  const wrongPath = await proxy(new Request('https://pear.test/elsewhere?url=https%3A%2F%2Fexample.com', { headers: { 'x-tiny-proxy': '1' } }))
  expect(wrongPath.status).toBe(400)

  const file = await proxy(marked('file:///etc/passwd'))
  expect(file.status).toBe(400)

  const credentials = await proxy(marked('https://user:secret@example.com/'))
  expect(credentials.status).toBe(400)
})

test('loopback and private destinations are refused without the development exception', async () => {
  for (const host of [
    'localhost', 'localhost.', '127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.169.254',
    '[::]', '[::1]', '[fd00::1]', '[fe80::1]',
    '[::ffff:127.0.0.1]', '[::ffff:7f00:1]', '[::ffff:c0a8:101]', '[::7f00:1]', '[64:ff9b::7f00:1]',
  ]) {
    expect(isPrivateHost(host), host).toBe(true)
  }
  for (const host of ['example.com', '8.8.8.8', '1.1.1.1', '[2606:4700:4700::1111]', '[64:ff9b::808:808]']) {
    expect(isPrivateHost(host), host).toBe(false)
  }

  const res = await proxy(marked('http://127.0.0.1:9/'))
  expect(res.status).toBe(403)
  expect(await res.text()).toContain('private')
})

test('a request is forwarded, cookies are dropped, and the final URL is reported', async () => {
  let seen: { method?: string; cookie?: string; forwarded?: string; body: string; userAgent?: string } = { body: '' }
  const upstream = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => (body += chunk))
    req.on('end', () => {
      const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value.join(', ') : value)
      seen = { method: req.method, cookie: first(req.headers.cookie), forwarded: first(req.headers['x-forwarded-for']), body, userAgent: first(req.headers['user-agent']) }
      res.writeHead(201, { 'content-type': 'text/plain', 'set-cookie': 'session=leak', 'x-echo': 'yes' })
      res.end('made')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  if (!address || typeof address === 'string') throw new Error('the upstream server has no port')

  try {
    const target = `http://127.0.0.1:${address.port}/submit?x=1`
    const res = await proxy(
      marked(target, { method: 'POST', headers: { cookie: 'secret=1', 'x-forwarded-for': '203.0.113.9', 'content-type': 'text/plain' }, body: 'hello' }),
      { allowPrivate: true },
    )
    expect(res.status).toBe(201)
    expect(res.headers.get('x-echo')).toBe('yes')
    expect(res.headers.get('set-cookie')).toBeNull()
    expect(res.headers.get('x-tiny-url')).toBe(target)
    expect(await res.text()).toBe('made')
    expect(seen).toMatchObject({ method: 'POST', body: 'hello', cookie: undefined, forwarded: undefined })
    expect(seen.userAgent).toBeTruthy()
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
