import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build as esbuild } from 'esbuild'
import { defineConfig, type Plugin } from 'vite'
import { proxy } from './server/proxy'

/** Vanilla's build output (`pnpm --filter @tiny/kernel build`): the kernel Worker, process runtime, Wasm, services. */
const OS_DIR = resolve(__dirname, '../vanilla/kernel/dist')
const OS_FILES = ['worker.js', 'process.js', 'host.html', 'tiny_vanilla_bg.wasm', 'services.json', 'userland.json']
const TYPES: Record<string, string> = { '.js': 'text/javascript', '.html': 'text/html', '.wasm': 'application/wasm', '.json': 'application/json' }

/**
 * Serves Vanilla at `/os/` in dev and copies it into the build. `host.html` is the process container: it gets a
 * `sandbox` CSP header so a process can never run with Desktop's origin, even if the file is opened directly.
 */
function vanilla(): Plugin {
  return {
    name: 'tiny-vanilla',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/os\/([\w.]+)$/.exec((req.url ?? '').split('?')[0]!)
        if (!m || !OS_FILES.includes(m[1]!)) return next()
        const file = join(OS_DIR, m[1]!)
        if (!existsSync(file)) {
          res.statusCode = 404
          return void res.end('Vanilla is not built: run `pnpm --filter @tiny/kernel build`')
        }
        res.setHeader('content-type', TYPES[m[1]!.slice(m[1]!.lastIndexOf('.'))] ?? 'application/octet-stream')
        if (m[1] === 'host.html') res.setHeader('content-security-policy', 'sandbox allow-scripts')
        res.end(readFileSync(file))
      })
    },
    closeBundle() {
      const out = resolve(__dirname, 'dist/os')
      mkdirSync(out, { recursive: true })
      for (const f of OS_FILES) if (existsSync(join(OS_DIR, f))) copyFileSync(join(OS_DIR, f), join(out, f))
    },
  }
}

/**
 * `/api/proxy?url=...` in dev and preview: the same handler as the Vercel Edge Function, adapted to Node's
 * request/response objects. Local targets are allowed here (the dev smoke pages live on localhost); the public
 * function refuses private addresses.
 */
function browserProxy(): Plugin {
  const attach = (server: { middlewares: { use(fn: (req: any, res: any, next: () => void) => void): void } }) => {
    server.middlewares.use((req, res, next) => {
      const path = (req.url ?? '').split('?')[0]
      if (path !== '/api/proxy') return next()
      void (async () => {
        const method = String(req.method ?? 'GET').toUpperCase()
        const headers = new Headers()
        for (const [name, value] of Object.entries(req.headers)) {
          if (Array.isArray(value)) headers.set(name, value.join(', '))
          else if (typeof value === 'string') headers.set(name, value)
        }
        const body = method === 'GET' || method === 'HEAD' ? undefined : req
        const request = new Request(new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), {
          method,
          headers,
          body: body as BodyInit | undefined,
          // Node streams need this; it is not in the DOM's RequestInit.
          duplex: body ? 'half' : undefined,
        } as RequestInit)
        const answer = await proxy(request, { allowPrivate: true })
        res.statusCode = answer.status
        res.statusMessage = answer.statusText
        answer.headers.forEach((value, name) => res.setHeader(name, value))
        if (answer.body) for await (const chunk of answer.body as unknown as AsyncIterable<Uint8Array>) res.write(chunk)
        res.end()
      })().catch((e) => {
        res.statusCode = 502
        res.setHeader('content-type', 'text/plain; charset=utf-8')
        res.end(`The proxy failed: ${(e as Error).message}\n`)
      })
    })
  }
  return {
    name: 'tiny-browser-proxy',
    configureServer: attach,
    configurePreviewServer: attach,
  }
}

const APPS_DIR = resolve(__dirname, 'apps')
const SDK_DIR = resolve(__dirname, 'sdk')
const VIRTUAL = 'virtual:bundled-apps'

const walk = (dir: string, base = ''): string[] =>
  readdirSync(dir).flatMap((n) => {
    const rel = base ? `${base}/${n}` : n
    return statSync(join(dir, n)).isDirectory() ? walk(join(dir, n), rel) : [rel]
  })

/**
 * Apps that ship with Pear live in `apps/<Name>.app/` as ordinary bundles (manifest, `Resources/`). This turns each into
 * a `{files}` source Desktop installs into the VFS on first boot: TypeScript files are compiled (a window script becomes
 * a classic script that bundles the SDK; `main.ts`, if present, becomes the process, otherwise the SDK's standard host).
 */
function bundledApps(): Plugin {
  const compile = async (entry: string, format: 'iife' | 'esm') => {
    const r = await esbuild({
      entryPoints: [entry], bundle: true, write: false, format, target: 'es2022', minify: false, sourcemap: false, logLevel: 'silent',
      alias: { '@tiny/sdk': join(SDK_DIR, 'client.ts') },
    })
    return r.outputFiles[0]!.text
  }
  return {
    name: 'tiny-apps',
    resolveId: (id) => (id === VIRTUAL ? `\0${VIRTUAL}` : null),
    async load(id) {
      if (id !== `\0${VIRTUAL}`) return null
      const apps: unknown[] = []
      const hostSource = await compile(join(SDK_DIR, 'host.ts'), 'esm')
      for (const dir of existsSync(APPS_DIR) ? readdirSync(APPS_DIR).filter((n) => n.endsWith('.app')) : []) {
        const root = join(APPS_DIR, dir)
        try {
        const files: Record<string, string> = {}
        const all = walk(root)
        // only entry points are compiled: the process (`main.ts` at the root) and scripts a page loads; modules they import are bundled in
        const loaded = new Set<string>()
        for (const rel of all.filter((r) => r.endsWith('.html'))) {
          for (const m of readFileSync(join(root, rel), 'utf8').matchAll(/<script[^>]*\ssrc="([^"]+)"/g)) loaded.add(join(rel, '..', m[1]!).replace(/\\/g, '/').replace(/^\.\//, ''))
        }
        for (const rel of all) {
          const abs = join(root, rel)
          this.addWatchFile(abs)
          if (rel.endsWith('.d.ts')) continue
          if (rel.endsWith('.ts') && rel !== 'main.ts' && !loaded.has(rel.replace(/\.ts$/, '.js'))) continue
          if (rel.endsWith('.ts')) {
            const out = rel.replace(/\.ts$/, '.js')
            files[out] = await compile(abs, rel === 'main.ts' ? 'esm' : 'iife')
          } else files[rel] = readFileSync(abs, 'utf8')
        }
        files['main.js'] ??= hostSource
        const manifest = JSON.parse(files['manifest.json']!)
        manifest.entry ??= 'main.js'
        files['manifest.json'] = JSON.stringify(manifest)
        const build = createHash('sha256').update(JSON.stringify(files)).digest('hex').slice(0, 16)
        files['.build'] = build
        apps.push({ id: manifest.id, name: manifest.name, dir, build, files })
        } catch (e) {
          // one broken app (a half-written file, a type error) must not take the desktop down with it
          this.warn(`${dir} was left out: ${(e as Error).message.split('\n')[0]}`)
        }
      }
      return `export default ${JSON.stringify(apps)}`
    },
    handleHotUpdate({ file, server }) {
      if (file.startsWith(APPS_DIR) || file.startsWith(SDK_DIR)) {
        const mod = server.moduleGraph.getModuleById(`\0${VIRTUAL}`)
        if (mod) server.moduleGraph.invalidateModule(mod)
        server.ws.send({ type: 'full-reload' })
        return []
      }
    },
  }
}

export default defineConfig({
  plugins: [vanilla(), bundledApps(), browserProxy()],
  server: { port: 5173, strictPort: true, fs: { allow: ['..'] } },
  preview: { port: 5173, strictPort: true },
  build: { target: 'es2022' },
})
