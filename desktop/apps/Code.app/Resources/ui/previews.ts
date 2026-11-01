// Previews shown beside a file: Markdown, Mermaid, a JSON tree and a Merkle tree (SVG is drawn by
// main.ts, as an image). Each renders into a DOM element the editor owns. Markdown goes through
// `marked` and is sanitized by DOMPurify; Mermaid is a large library, loaded from the app bundle
// the first time a diagram needs it.
import { joinPath, tiny } from '@tiny/sdk'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import * as monaco from 'monaco-editor/editor/editor.api.js'

export type PreviewKind = 'svg' | 'markdown' | 'mermaid' | 'json' | 'merkle'

export const KIND_LABEL: Record<PreviewKind, string> = {
  svg: 'SVG Preview',
  markdown: 'Markdown Preview',
  mermaid: 'Mermaid Preview',
  json: 'JSON Tree',
  merkle: 'Merkle Tree',
}

/** The preview a file type opens by default; null for files with none (a Merkle tree can be shown for any file). */
export function defaultKind(path: string | null): PreviewKind | null {
  if (!path) return null
  if (/\.svg$/i.test(path)) return 'svg'
  if (/\.(md|markdown|mdx)$/i.test(path)) return 'markdown'
  if (/\.(mmd|mermaid)$/i.test(path)) return 'mermaid'
  if (/\.jsonc?$/i.test(path)) return 'json'
  return null
}

export interface PreviewContext {
  path: string
  text: string
  dark: boolean
  /** The file's bytes (the editor's text if it is open), for the Merkle tree. */
  bytes(): Promise<Uint8Array | null>
  /** Another project file by relative path, for images in Markdown. */
  readRel(rel: string): Promise<Uint8Array | null>
  openFile(rel: string): void
  /** False once a newer render has started, so a slow one does not overwrite it. */
  current(): boolean
  /** Merkle chunk size in bytes; 0 picks one that keeps the tree readable. */
  chunk: number
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text !== undefined) e.textContent = text
  return e
}

export async function render(kind: PreviewKind, into: HTMLElement, ctx: PreviewContext): Promise<void> {
  into.dataset.kind = kind
  try {
    if (kind === 'markdown') await renderMarkdown(into, ctx)
    else if (kind === 'mermaid') await renderMermaidFile(into, ctx)
    else if (kind === 'json') renderJson(into, ctx)
    else if (kind === 'merkle') await renderMerkle(into, ctx)
  } catch (e) {
    into.replaceChildren(el('pre', 'docerror', (e as Error).message || String(e)))
  }
}

// ---- Mermaid

let mermaidLoad: Promise<MermaidApi> | null = null
let diagramId = 0
interface MermaidApi {
  initialize(config: object): void
  parse(text: string): Promise<unknown>
  render(id: string, text: string): Promise<{ svg: string }>
}

function loadMermaid(): Promise<MermaidApi> {
  mermaidLoad ??= (async () => {
    const g = globalThis as unknown as { __mermaid?: MermaidApi }
    if (!g.__mermaid) {
      const bundle = await tiny.bundleInfo('org.tiny.code')
      const source = new TextDecoder().decode(await tiny.readFile(joinPath(bundle.path, 'Resources/lib/mermaid.js')))
      const script = document.createElement('script')
      script.textContent = source // an inline script: the window's content policy allows these, not eval
      document.head.append(script)
      script.remove()
    }
    if (!g.__mermaid) throw new Error('The Mermaid library did not load.')
    return g.__mermaid
  })().catch((e) => {
    mermaidLoad = null
    throw e
  })
  return mermaidLoad
}

/** A diagram as SVG markup. Throws the parser's message for a diagram that does not parse. */
async function diagram(code: string, dark: boolean): Promise<string> {
  const mermaid = await loadMermaid()
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: dark ? 'dark' : 'default', fontFamily: 'inherit' })
  const id = `mmd${++diagramId}`
  try {
    await mermaid.parse(code) // fails cleanly; render() would leave an error block in the page
    return (await mermaid.render(id, code)).svg
  } finally {
    document.getElementById(`d${id}`)?.remove()
  }
}

async function renderMermaidFile(into: HTMLElement, ctx: PreviewContext): Promise<void> {
  if (!ctx.text.trim()) {
    into.replaceChildren(el('div', 'docempty', 'Write a diagram, for example “graph TD; A-->B”.'))
    return
  }
  const svg = await diagram(ctx.text, ctx.dark)
  if (!ctx.current()) return
  const box = el('div', 'mermaid-block')
  box.innerHTML = svg
  into.replaceChildren(box)
}

// ---- Markdown

const slug = (s: string): string => s.toLowerCase().trim().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-')

/** Monaco language id for a fence's info string (js, ts, sh, yml...). */
function languageFor(name: string): string | null {
  const n = name.toLowerCase()
  const alias: Record<string, string> = { js: 'javascript', ts: 'typescript', sh: 'shell', bash: 'shell', zsh: 'shell', yml: 'yaml', py: 'python', rs: 'rust', md: 'markdown', svg: 'xml', wat: 'wat' }
  const want = alias[n] ?? n
  return monaco.languages.getLanguages().find((l) => l.id === want || l.aliases?.some((a) => a.toLowerCase() === want))?.id ?? null
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml' }

const resolveRel = (from: string, href: string): string => {
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : ''
  const out: string[] = []
  for (const p of (href.startsWith('/') ? href.slice(1) : `${dir}/${href}`).split(/[?#]/)[0]!.split('/')) {
    if (p === '..') out.pop()
    else if (p && p !== '.') out.push(p)
  }
  return out.join('/')
}

async function renderMarkdown(into: HTMLElement, ctx: PreviewContext): Promise<void> {
  const html = DOMPurify.sanitize(marked.parse(ctx.text, { gfm: true, async: false }) as string)
  const scroll = into.scrollTop
  const root = el('div', 'markdown')
  root.innerHTML = html
  for (const h of root.querySelectorAll('h1,h2,h3,h4,h5,h6')) h.id = slug(h.textContent ?? '')

  const jobs: Array<Promise<void>> = []
  for (const code of root.querySelectorAll('pre > code')) {
    const lang = /language-(\S+)/.exec(code.className)?.[1]
    const pre = code.parentElement!
    const source = code.textContent ?? ''
    if (lang === 'mermaid') {
      jobs.push(
        diagram(source, ctx.dark).then(
          (svg) => {
            const box = el('div', 'mermaid-block')
            box.innerHTML = svg
            pre.replaceWith(box)
          },
          (e: Error) => pre.replaceWith(el('pre', 'docerror', `Mermaid: ${e.message}`)),
        ),
      )
    } else if (lang && languageFor(lang)) {
      jobs.push(
        monaco.editor.colorize(source, languageFor(lang)!, { tabSize: 2 }).then((colored) => {
          code.innerHTML = colored
        }),
      )
    }
  }
  for (const img of root.querySelectorAll('img')) {
    const src = img.getAttribute('src') ?? ''
    if (!src || /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue
    const rel = resolveRel(ctx.path, src)
    jobs.push(
      ctx.readRel(rel).then((bytes) => {
        if (!bytes) return
        const type = MIME[rel.slice(rel.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream'
        img.src = URL.createObjectURL(new Blob([bytes as BlobPart], { type }))
      }),
    )
  }
  await Promise.all(jobs)
  if (!ctx.current()) return

  into.replaceChildren(root)
  into.scrollTop = scroll
  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest('a')
    const href = a?.getAttribute('href')
    if (!a || !href) return
    e.preventDefault()
    if (href.startsWith('#')) root.querySelector(`[id="${CSS.escape(href.slice(1))}"]`)?.scrollIntoView({ block: 'start' })
    else if (/^https?:/i.test(href)) void tiny.shell.open(href)
    else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) ctx.openFile(resolveRel(ctx.path, href))
  })
}

// ---- JSON tree

const jsonOpen = new Map<string, Set<string>>()

/** JSON with comments and trailing commas (what .jsonc and Pear manifests allow). */
function parseJsonc(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch (first) {
    let out = ''
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!
      if (c === '"') {
        let j = i + 1
        while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1
        out += text.slice(i, j + 1)
        i = j
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i++
        out += '\n'
      } else if (c === '/' && text[i + 1] === '*') {
        i = text.indexOf('*/', i + 2)
        if (i < 0) break
        i++
      } else out += c
    }
    try {
      return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
    } catch {
      throw first
    }
  }
}

const MAX_CHILDREN = 300

function jsonNode(value: unknown, key: string | null, path: string, depth: number, open: Set<string>, firstTime: boolean): HTMLElement {
  const keyEl = (): HTMLElement => (key === null ? el('span') : el('span', 'jk', key))
  const colon = (): HTMLElement | string => (key === null ? '' : el('span', 'jc', ': '))
  if (value === null || typeof value !== 'object') {
    const row = el('div', 'jleaf')
    row.title = path
    const v = el('span', `jv jv-${value === null ? 'null' : typeof value}`, typeof value === 'string' ? JSON.stringify(value) : String(value))
    row.append(keyEl(), colon(), v)
    return row
  }
  const isArray = Array.isArray(value)
  const entries = isArray ? (value as unknown[]).map((v, i) => [String(i), v] as [string, unknown]) : Object.entries(value as object)
  const details = el('details', 'jnode')
  details.dataset.p = path
  details.open = firstTime ? depth < 2 : open.has(path)
  details.addEventListener('toggle', () => {
    if (details.open) open.add(path)
    else open.delete(path)
  })
  const summary = el('summary')
  summary.title = path
  summary.append(keyEl(), colon(), el('span', 'jsum', isArray ? `Array(${entries.length})` : entries.length ? `{${entries.length}}` : '{}'))
  details.append(summary)
  const children = el('div', 'jchildren')
  for (const [k, v] of entries.slice(0, MAX_CHILDREN)) {
    children.append(jsonNode(v, isArray ? `[${k}]` : k, isArray ? `${path}[${k}]` : `${path}.${k}`, depth + 1, open, firstTime))
  }
  if (entries.length > MAX_CHILDREN) children.append(el('div', 'jmore', `… ${entries.length - MAX_CHILDREN} more`))
  details.append(children)
  return details
}

function renderJson(into: HTMLElement, ctx: PreviewContext): void {
  let value: unknown
  try {
    value = parseJsonc(ctx.text)
  } catch (e) {
    into.replaceChildren(el('pre', 'docerror', `Invalid JSON: ${(e as Error).message}`))
    return
  }
  const firstTime = !jsonOpen.has(ctx.path)
  const open = jsonOpen.get(ctx.path) ?? new Set<string>()
  jsonOpen.set(ctx.path, open)
  const scroll = into.scrollTop
  const tree = el('div', 'jsontree')
  tree.append(jsonNode(value, null, '$', 0, open, firstTime))
  into.replaceChildren(tree)
  into.scrollTop = scroll
}

/** Open or close every node of the rendered JSON tree. */
export function jsonToggleAll(into: HTMLElement, expand: boolean): void {
  for (const d of into.querySelectorAll('details')) d.open = expand
}

// ---- Merkle tree

const K256 = Uint32Array.from(
  '428a2f98 71374491 b5c0fbcf e9b5dba5 3956c25b 59f111f1 923f82a4 ab1c5ed5 d807aa98 12835b01 243185be 550c7dc3 72be5d74 80deb1fe 9bdc06a7 c19bf174 e49b69c1 efbe4786 0fc19dc6 240ca1cc 2de92c6f 4a7484aa 5cb0a9dc 76f988da 983e5152 a831c66d b00327c8 bf597fc7 c6e00bf3 d5a79147 06ca6351 14292967 27b70a85 2e1b2138 4d2c6dfc 53380d13 650a7354 766a0abb 81c2c92e 92722c85 a2bfe8a1 a81a664b c24b8b70 c76c51a3 d192e819 d6990624 f40e3585 106aa070 19a4c116 1e376c08 2748774c 34b0bcb5 391c0cb3 4ed8aa4a 5b9cca4f 682e6ff3 748f82ee 78a5636f 84c87814 8cc70208 90befffa a4506ceb bef9a3f7 c67178f2'.split(' ').map((h) => parseInt(h, 16)),
)

/** SHA-256 (WebCrypto is not available to a sandboxed window, and the tree wants it synchronously). */
export function sha256(data: Uint8Array): Uint8Array {
  const h = Uint32Array.of(0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19)
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6)
  padded.set(data)
  padded[data.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor((data.length * 8) / 2 ** 32))
  view.setUint32(padded.length - 4, (data.length * 8) >>> 0)
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3)
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10)
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as number[]
    for (let i = 0; i < 64; i++) {
      const t1 = (hh! + (rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25)) + ((e! & f!) ^ (~e! & g!)) + K256[i]! + w[i]!) >>> 0
      const t2 = ((rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22)) + ((a! & b!) ^ (a! & c!) ^ (b! & c!))) >>> 0
      hh = g
      g = f
      f = e
      e = (d! + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }
    ;[a, b, c, d, e, f, g, hh].forEach((v, i) => (h[i] = (h[i]! + v!) >>> 0))
  }
  const out = new Uint8Array(32)
  const ov = new DataView(out.buffer)
  h.forEach((v, i) => ov.setUint32(i * 4, v))
  return out
}

const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
const tagged = (tag: number, ...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(1 + parts.reduce((n, p) => n + p.length, 0))
  out[0] = tag
  let at = 1
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

interface MNode {
  hash: Uint8Array
  /** Byte range covered, inclusive start, exclusive end. */
  from: number
  to: number
  children: MNode[]
  leaf?: number
}

const MAX_LEAVES = 256
export const MERKLE_CHUNKS = [0, 64, 256, 1024, 4096, 16384]

/** The tree, RFC 6962 style: leaves hash 0x00‖chunk, parents hash 0x01‖left‖right; an odd node moves up as it is. */
export function merkle(bytes: Uint8Array, chunk: number): { root: MNode | null; chunk: number; leaves: number; depth: number } {
  let size = chunk || 64
  while (Math.ceil(bytes.length / size) > MAX_LEAVES) size *= 2
  let level: MNode[] = []
  for (let i = 0, n = 0; i < bytes.length || (i === 0 && n === 0); i += size, n++) {
    const part = bytes.subarray(i, Math.min(i + size, bytes.length))
    level.push({ hash: sha256(tagged(0, part)), from: i, to: i + part.length, children: [], leaf: n })
    if (bytes.length === 0) break
  }
  const leaves = level.length
  let depth = 0
  while (level.length > 1) {
    const next: MNode[] = []
    for (let i = 0; i < level.length; i += 2) {
      const l = level[i]!
      const r = level[i + 1]
      next.push(r ? { hash: sha256(tagged(1, l.hash, r.hash)), from: l.from, to: r.to, children: [l, r] } : l)
    }
    level = next
    depth++
  }
  return { root: level[0] ?? null, chunk: size, leaves, depth }
}

function merkleNode(n: MNode, depth: number, label: string): HTMLElement {
  const info = `${n.from.toLocaleString()}–${n.to.toLocaleString()}`
  const hash = el('code', 'mh', hex(n.hash).slice(0, 12) + '…')
  hash.title = hex(n.hash)
  if (!n.children.length) {
    const row = el('div', 'mleaf')
    row.append(el('span', 'mlabel', n.leaf !== undefined ? `chunk ${n.leaf}` : label), hash, el('span', 'mrange', `bytes ${info}`))
    return row
  }
  const d = el('details', 'mnode')
  d.open = depth < 2
  const s = el('summary')
  s.append(el('span', 'mlabel', label), hash, el('span', 'mrange', `bytes ${info}`))
  d.append(s)
  const kids = el('div', 'jchildren')
  n.children.forEach((c, i) => kids.append(merkleNode(c, depth + 1, i === 0 ? 'left' : 'right')))
  d.append(kids)
  return d
}

async function renderMerkle(into: HTMLElement, ctx: PreviewContext): Promise<void> {
  const bytes = await ctx.bytes()
  if (!ctx.current()) return
  if (!bytes) {
    into.replaceChildren(el('pre', 'docerror', 'The file could not be read.'))
    return
  }
  const t = merkle(bytes, ctx.chunk)
  const box = el('div', 'merkle')
  const facts = el('dl', 'mfacts')
  const row = (k: string, v: string | HTMLElement): void => {
    facts.append(el('dt', undefined, k))
    const dd = el('dd')
    dd.append(v)
    facts.append(dd)
  }
  row('File', `${ctx.path.split('/').pop()} · ${bytes.length.toLocaleString()} bytes`)
  row('Chunk size', `${t.chunk.toLocaleString()} bytes${ctx.chunk && ctx.chunk !== t.chunk ? ` (raised from ${ctx.chunk.toLocaleString()} to keep ≤ ${MAX_LEAVES} leaves)` : ''}`)
  row('Leaves · depth', `${t.leaves.toLocaleString()} · ${t.depth}`)
  row('Root (SHA-256)', el('code', 'mroot', t.root ? hex(t.root.hash) : ''))
  box.append(facts)
  if (t.root) box.append(merkleNode(t.root, 0, 'root'))
  box.append(el('p', 'mnote', 'Leaves hash 0x00‖chunk, parents hash 0x01‖left‖right. Edit the file to see which hashes, and which path up to the root, change.'))
  const scroll = into.scrollTop
  into.replaceChildren(box)
  into.scrollTop = scroll
}
