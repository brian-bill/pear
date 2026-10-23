import { build } from 'esbuild'
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

mkdirSync('dist', { recursive: true })
await build({
  entryPoints: { worker: 'src/worker.ts', main: 'test/harness/main.ts' },
  bundle: true,
  format: 'esm',
  target: 'es2022',
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
})

// The process runtime is a classic script: the sandboxed frame has an opaque origin, where
// module Workers cannot load from a blob.
await build({
  entryPoints: { process: 'src/runtime.ts' },
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outdir: 'dist',
  sourcemap: true,
  logLevel: 'info',
})

// The process container page: one inline script pinned by hash, so the CSP can forbid everything else.
// The meta CSP is inherited by the Worker (a blob) that runs the process, which is what blocks
// fetch/WebSocket/import of remote code. `sandbox` in a header is added by serve.mjs as a second layer.
const host = await build({
  entryPoints: ['src/host-page.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  write: false,
  logLevel: 'info',
})
const script = host.outputFiles[0].text.trimEnd()
if (script.includes('</script')) throw new Error('host script must not contain a closing script tag')
const hash = createHash('sha256').update(script).digest('base64')
const csp = `default-src 'none'; script-src 'sha256-${hash}' blob:; worker-src blob:; connect-src 'none'`
writeFileSync(
  'dist/host.html',
  `<!doctype html>\n<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${csp}">\n<script>${script}</script>\n`,
)

// Each userland program and system service (the processes behind `tiny.launch`, ...) becomes one self-contained
// module, because a program in the VFS cannot import anything. `dist/<dir>.json` maps name to source; see src/userland.ts.
async function bundlePrograms(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && f !== 'lib.ts')
  const built = await build({
    entryPoints: files.map((f) => `${dir}/${f}`),
    bundle: true,
    format: 'esm',
    target: 'es2022',
    write: false,
    outdir: 'out',
    logLevel: 'info',
  })
  const sources = {}
  for (const file of built.outputFiles) sources[file.path.split('/').pop().replace(/\.js$/, '')] = file.text
  writeFileSync(`dist/${dir}.json`, JSON.stringify(sources))
}
await bundlePrograms('userland')
await bundlePrograms('services')

copyFileSync('pkg/tiny_vanilla_bg.wasm', 'dist/tiny_vanilla_bg.wasm')
copyFileSync('test/harness/index.html', 'dist/index.html')

// Service worker: caches everything above so the OS loads offline. The cache name carries a hash of the files, so a
// new build is a new cache and the old worker keeps serving until the user restarts (see sw/sw.ts, tab-lock.ts).
const shipped = readdirSync('dist').filter((f) => !f.endsWith('.map') && f !== 'sw.js' && f !== 'os-manifest.json')
const buildHash = createHash('sha256')
for (const f of shipped.sort()) buildHash.update(f).update(readFileSync(`dist/${f}`))
const buildId = buildHash.digest('hex').slice(0, 12)
writeFileSync('dist/os-manifest.json', JSON.stringify(['./', ...shipped]))
await build({
  entryPoints: { sw: 'sw/sw.ts' },
  bundle: true,
  format: 'iife',
  target: 'es2022',
  outdir: 'dist',
  define: { __TINY_BUILD_ID__: JSON.stringify(buildId) },
  logLevel: 'info',
})
