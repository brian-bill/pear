/// Relative imports in programs. A program runs from a module URL with no place on disk, so `import './utils/url.js'`
/// has nothing to resolve against. Before a program starts the kernel reads the files it imports (and what they import)
/// from inside its bundle or folder and hands them to the process runtime, which gives each its own module URL and
/// rewrites the specifiers. A cycle is an error.
import { SysError } from './errors'
import type { FileSystem } from './fs'

const MAX_DEPTH = 16
const MAX_BYTES = 8 * 1024 * 1024
const STATIC_SRC = String.raw`(\b(?:import|export)\b[^'"` + '`' + String.raw`;]*?\bfrom\s*|\bimport\s*)(['"])(\.{1,2}\/[^'"\n]+)\2`
const DYNAMIC_SRC = String.raw`\bimport\(\s*(['"])(\.{1,2}\/[^'"\n]+)\1\s*\)`
const dec = new TextDecoder()

/** The files a program imports: text by absolute path, and for each file (and the program, under `''`) which path each specifier means. */
export interface ModuleGraph {
  files: Record<string, { text: string; deps: Record<string, string> }>
  /** The program's own specifiers. */
  deps: Record<string, string>
}

const specifiers = (text: string): string[] => [
  ...[...text.matchAll(new RegExp(STATIC_SRC, 'g'))].map((m) => m[3]!),
  ...[...text.matchAll(new RegExp(DYNAMIC_SRC, 'g'))].map((m) => m[2]!),
]

export const hasRelativeImports = (source: Uint8Array): boolean => {
  const text = dec.decode(source)
  return new RegExp(STATIC_SRC).test(text) || new RegExp(DYNAMIC_SRC).test(text)
}

/** Replace each relative specifier in `text` with what `url(spec)` says. Used by the process runtime. */
export function rewriteImports(text: string, url: (spec: string) => string): string {
  return text
    .replace(new RegExp(STATIC_SRC, 'g'), (_all, pre: string, q: string, spec: string) => `${pre}${q}${url(spec)}${q}`)
    .replace(new RegExp(DYNAMIC_SRC, 'g'), (_all, q: string, spec: string) => `import(${q}${url(spec)}${q})`)
}

const dirOf = (p: string) => p.slice(0, p.lastIndexOf('/')) || '/'

function resolve(from: string, rel: string): string {
  const out = dirOf(from).split('/').filter(Boolean)
  for (const part of rel.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return `/${out.join('/')}`
}

/** Read what the program at `path` imports. `root` is the folder the imports may not leave. */
export async function collectImports(fs: FileSystem, path: string, source: Uint8Array, root: string): Promise<ModuleGraph> {
  let total = 0
  const files: ModuleGraph['files'] = {}
  const visit = async (file: string, text: string, stack: string[]): Promise<Record<string, string>> => {
    if (stack.length > MAX_DEPTH) throw new SysError('ELOOP', `imports are nested more than ${MAX_DEPTH} deep at ${file}`)
    const deps: Record<string, string> = {}
    for (const spec of new Set(specifiers(text))) {
      const target = resolve(file, spec)
      if (target !== root && !target.startsWith(root === '/' ? '/' : `${root}/`)) throw new SysError('EACCES', `${spec} (imported by ${file}) is outside ${root}`)
      if (stack.includes(target)) throw new SysError('ELOOP', `circular import: ${[...stack, target].join(' -> ')}`)
      deps[spec] = target
      if (files[target]) continue
      let code: string
      try {
        code = dec.decode(await fs.readFile(target))
      } catch {
        throw new SysError('ENOENT', `cannot find module ${spec} imported by ${file}`)
      }
      total += code.length
      if (total > MAX_BYTES) throw new SysError('EFBIG', 'the program and its imports are too large')
      const entry = { text: code, deps: {} as Record<string, string> }
      files[target] = entry
      entry.deps = await visit(target, code, [...stack, target])
    }
    return deps
  }
  return { files, deps: await visit(path, dec.decode(source), [path]) }
}
