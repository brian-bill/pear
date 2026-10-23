// Minimal static server for the test harness (`dist/`).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'

const types = { '.html': 'text/html', '.js': 'text/javascript', '.wasm': 'application/wasm', '.map': 'application/json' }
const root = join(import.meta.dirname, 'dist')

createServer(async (req, res) => {
  const requested = normalize(new URL(req.url, 'http://x').pathname).replace(/^(\.\.[/\\])+/, '')
  const path = requested === '/' ? '/index.html' : requested
  try {
    const body = await readFile(join(root, path))
    const headers = { 'content-type': types[extname(path)] ?? 'application/octet-stream' }
    // The process container must never run with the kernel's origin, even if opened directly.
    if (path === '/host.html') headers['content-security-policy'] = 'sandbox allow-scripts'
    res.writeHead(200, headers)
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(4173, () => console.log('serving dist on http://localhost:4173'))
