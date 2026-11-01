// The AssemblyScript compiler worker entry, bundled by generate.mjs into
// `compilerSource.ts` (a string). At runtime the string becomes a module worker
// (`{ type: 'module' }` from a blob URL) and compiles AssemblyScript sources to
// WebAssembly entirely in the browser.
//
// Messages in:  { id, op: 'compile', entry, files: Record<string, string>, optimize? }
// Messages out: { id, ok: true, wasm: ArrayBuffer, wat?: string, log: string }
//            or { id, ok: false, log: string }
import { compileString } from 'assemblyscript/asc'

// The prelude (in the generated wrapper) queues early messages in `__pearQueue`; once the compiler
// is ready, `__pearDrain` is handed to it and later messages come straight to `self.onmessage`.
const handle = async (e) => {
  const { id, entry, files, optimize } = e.data ?? {}
  if (e.data?.op !== 'compile' || typeof entry !== 'string' || !files) {
    return void self.postMessage({ id: id ?? 0, ok: false, log: 'bad request' })
  }
  try {
    // compileString makes its own output streams (the ones in its options are ignored): the
    // diagnostics are on the result
    const out = await compileString(files, {
      optimizeLevel: optimize ? 3 : 1,
      shrinkLevel: optimize ? 2 : 0,
      noColors: true,
    })
    const text = (stream) => (stream ? String(stream.toString()).trim() : '')
    const log = text(out.stdout)
    const errors = text(out.stderr)
    if (out.error || !out.binary) {
      self.postMessage({ id, ok: false, log: [log, errors, out.error ? String(out.error) : 'no binary emitted'].filter(Boolean).join('\n') || 'compile failed' })
    } else {
      self.postMessage({ id, ok: true, wasm: out.binary.buffer ?? out.binary, wat: out.text ?? undefined, log: [log, errors].filter(Boolean).join('\n') })
    }
  } catch (err) {
    self.postMessage({ id, ok: false, log: String(err) })
  }
}
;(self).__pearDrain = (e) => void handle(e)
self.onmessage = (e) => void handle(e)
