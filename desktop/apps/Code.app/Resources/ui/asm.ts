// The AssemblyScript extension — compiles AssemblyScript (`src/*.ts`) to WebAssembly entirely in
// the browser. The compiler is a generated file inside this bundle (`Resources/ui/asc.js`, 15 MB):
// it is read on demand (apps may read their own bundle) and run as a module worker from a blob URL,
// so no toolchain and no server are ever involved.
import { joinPath, tiny } from '@tiny/sdk'
import type { ExtActions, ExtHost, ExtensionDef, ToolbarButton } from './extension'

const ASC_URL = 'Resources/ui/asc.js'
const ENTRY = 'src/main.ts'
const OUT = 'src/main.wasm'
const TIMEOUT = 180_000

let host: ExtHost | null = null
let worker: Worker | null = null
let workerJob: number = 0
const replies = new Map<number, (m: CompilerReply) => void>()

interface CompilerReply {
  id: number
  ok: boolean
  wasm?: ArrayBuffer
  wat?: string
  log?: string
}

async function ensureWorker(): Promise<Worker> {
  if (worker) return worker
  host!.log('Loading the AssemblyScript compiler (first build takes a moment)…')
  const bundle = await tiny.bundleInfo('org.tiny.code')
  const source = new TextDecoder().decode(await tiny.readFile(joinPath(bundle.path, ASC_URL)))
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
  const w = new Worker(url)
  w.onmessage = (e: MessageEvent<CompilerReply>) => replies.get(e.data.id)?.(e.data)
  w.onerror = (e) => host?.log(`Compiler worker failed: ${e.message}`, 'err')
  worker = w
  return w
}

function compile(files: Record<string, string>, optimize: boolean): Promise<CompilerReply> {
  const id = ++workerJob
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      replies.delete(id)
      reject(new Error('the compiler did not answer in 3 minutes'))
    }, TIMEOUT)
    replies.set(id, (m) => {
      clearTimeout(timer)
      replies.delete(id)
      resolve(m)
    })
    void ensureWorker().then((w) => w.postMessage({ id, op: 'compile', entry: ENTRY, files, optimize }), reject)
  })
}

async function collectSources(): Promise<Record<string, string> | null> {
  const project = host!.project()
  if (!project) return null
  const dec = new TextDecoder()
  const files: Record<string, string> = {}
  const walk = async (rel: string): Promise<void> => {
    for (const e of await tiny.readdir(`${project}/${rel}`)) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (e.kind === 'dir') await walk(child)
      else if (/\.ts$/.test(e.name)) {
        // unsaved edits are built too: what is in the editor is what gets compiled
        const buffer = host!.buffer(child)
        if (buffer !== null) files[child] = buffer
        else {
          const bytes = await host!.readProjectFile(child)
          if (bytes) files[child] = dec.decode(bytes)
        }
      }
    }
  }
  await walk('src')
  return Object.keys(files).length ? files : null
}

/**
 * The compiler's diagnostics, as positions in files:
 *   ERROR AS200: Conversion from type 'f64' to 'i16' requires an explicit cast.
 *      :
 *    1 │ export function mult(n: i16, t: f64): i16 { return n * t }
 *      │                                                    ~~~~~
 *      └─ in src/main.ts(1,52)
 */
function parseDiagnostics(log: string): Parameters<ExtHost['problems']>[0] {
  const out: Parameters<ExtHost['problems']>[0] = []
  for (const block of log.split(/\n(?=(?:ERROR|WARNING) )/)) {
    const head = block.match(/^(ERROR|WARNING) (?:AS|TS)?\w+: ([^\n]*)/)
    const where = block.match(/in (\S+?)\((\d+),(\d+)\)\s*$/m)
    if (!head || !where) continue
    const col = Number(where[3])
    const tildes = block.match(/│\s+(~+)/)?.[1]?.length ?? 1
    out.push({ path: where[1]!, line: Number(where[2]), col, endCol: col + tildes, message: head[2]!, severity: head[1] === 'ERROR' ? 'error' : 'warning' })
  }
  return out
}

async function build(): Promise<void> {
  if (!host) return
  const started = Date.now()
  host.showOutput()
  try {
    const files = await collectSources()
    if (!files || !files[ENTRY]) {
      host.log(`Nothing to build: this extension compiles AssemblyScript sources under src/, starting at ${ENTRY}.`, 'err')
      return
    }
    host.log(`Building ${ENTRY} (AssemblyScript)…`)
    host.problems([])
    const out = await compile(files, false)
    host.problems(parseDiagnostics(out.log ?? ''))
    if (!out.ok || !out.wasm) {
      host.log((out.log || 'Build failed.').trim(), 'err')
      host.log(`Build failed. ${OUT} was not updated: anything built from it still has the previous build's exports.`, 'err')
      host.status('Build failed')
      return
    }
    if (out.log?.trim()) host.log(out.log.trim())
    await tiny.writeFile(joinPath(host.project()!, OUT), new Uint8Array(out.wasm))
    const kb = (out.wasm.byteLength / 1024).toFixed(1)
    host.log(`Built ${OUT} (${kb} KB in ${((Date.now() - started) / 1000).toFixed(1)} s)`, 'ok')
    host.status(`Built ${OUT}`)
  } catch (e) {
    host.log(`Build failed: ${(e as Error).message}`, 'err')
    host.status('Build failed')
  }
}

export const assemblyScriptExtension: ExtensionDef = {
  id: 'org.pear.code.assemblyscript',
  name: 'AssemblyScript',
  description: 'Compile src/main.ts (AssemblyScript, a TypeScript-like language) to WebAssembly in the browser. The previewed app loads src/main.wasm.',
  tag: 'built-in',
  installedByDefault: true,
  activate(h) {
    host = h
    let hasAsm = false
    const button: ToolbarButton = {
      id: 'build',
      label: 'Build',
      icon: 'package',
      title: `Compile ${ENTRY} to WebAssembly (Cmd+Shift+B)`,
      primary: false,
      visible: () => !!h.project() && hasAsm,
      run: () => void build(),
    }
    const actions: ExtActions = {
      toolbar: [button],
      async onDidOpenProject() {
        hasAsm = !!(await h.fileExists(ENTRY))
      },
      onDidSaveProject(rel) {
        if (rel === ENTRY || rel.startsWith('src/')) hasAsm = true
      },
      onDidCloseProject() {
        hasAsm = false
      },
    }
    return actions
  },
}

/** Cmd+Shift+B. */
export function buildShortcut(): void {
  void build()
}
