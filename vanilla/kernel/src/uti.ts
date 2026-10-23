/// File types: UTI-style identifiers with a conformance hierarchy, found from extension, MIME type, or magic bytes.

export interface TypeInfo {
  uti: string
  mime: string
  description: string
  /** This type and every type it conforms to, nearest first (`public.data` and `public.item` at the end). */
  conformsTo: string[]
  ext: string | null
}

/** A name two definitions wanted. `kept` is the app (null: the system) whose definition is in effect. */
export interface TypeConflict {
  ext: string | null
  uti: string
  claims: Array<{ uti: string; appId: string | null }>
  kept: string | null
}

interface Def {
  uti: string
  parent: string[]
  mime: string
  description: string
  ext?: string[]
}

const DEFS: Def[] = [
  { uti: 'public.item', parent: [], mime: 'application/octet-stream', description: 'Item' },
  { uti: 'public.data', parent: ['public.item'], mime: 'application/octet-stream', description: 'Document' },
  { uti: 'public.directory', parent: ['public.item'], mime: 'inode/directory', description: 'Folder' },
  { uti: 'public.folder', parent: ['public.directory'], mime: 'inode/directory', description: 'Folder' },
  { uti: 'com.apple.application-bundle', parent: ['public.directory'], mime: 'application/x-tiny-app', description: 'Application', ext: ['app'] },
  { uti: 'public.symlink', parent: ['public.item'], mime: 'inode/symlink', description: 'Alias' },
  { uti: 'public.text', parent: ['public.data'], mime: 'text/plain', description: 'Text' },
  { uti: 'public.plain-text', parent: ['public.text'], mime: 'text/plain', description: 'Plain text document', ext: ['txt', 'text', 'log'] },
  { uti: 'net.daringfireball.markdown', parent: ['public.plain-text'], mime: 'text/markdown', description: 'Markdown document', ext: ['md', 'markdown'] },
  { uti: 'public.json', parent: ['public.text'], mime: 'application/json', description: 'JSON document', ext: ['json'] },
  { uti: 'public.xml', parent: ['public.text'], mime: 'application/xml', description: 'XML document', ext: ['xml', 'plist'] },
  { uti: 'public.html', parent: ['public.text'], mime: 'text/html', description: 'HTML document', ext: ['html', 'htm'] },
  { uti: 'public.css', parent: ['public.text'], mime: 'text/css', description: 'CSS stylesheet', ext: ['css'] },
  { uti: 'public.source-code', parent: ['public.text'], mime: 'text/plain', description: 'Source code' },
  { uti: 'com.netscape.javascript-source', parent: ['public.source-code'], mime: 'text/javascript', description: 'JavaScript source', ext: ['js', 'mjs'] },
  { uti: 'public.shell-script', parent: ['public.source-code'], mime: 'text/x-shellscript', description: 'Shell script', ext: ['sh'] },
  { uti: 'public.csv', parent: ['public.plain-text'], mime: 'text/csv', description: 'CSV document', ext: ['csv'] },
  { uti: 'public.image', parent: ['public.data'], mime: 'image/*', description: 'Image' },
  { uti: 'public.png', parent: ['public.image'], mime: 'image/png', description: 'PNG image', ext: ['png'] },
  { uti: 'public.jpeg', parent: ['public.image'], mime: 'image/jpeg', description: 'JPEG image', ext: ['jpg', 'jpeg'] },
  { uti: 'com.compuserve.gif', parent: ['public.image'], mime: 'image/gif', description: 'GIF image', ext: ['gif'] },
  { uti: 'public.svg-image', parent: ['public.image', 'public.xml'], mime: 'image/svg+xml', description: 'SVG image', ext: ['svg'] },
  { uti: 'org.webmproject.webp', parent: ['public.image'], mime: 'image/webp', description: 'WebP image', ext: ['webp'] },
  { uti: 'com.microsoft.bmp', parent: ['public.image'], mime: 'image/bmp', description: 'Windows bitmap', ext: ['bmp'] },
  { uti: 'public.tiff', parent: ['public.image'], mime: 'image/tiff', description: 'TIFF image', ext: ['tif', 'tiff'] },
  { uti: 'public.audio', parent: ['public.data'], mime: 'audio/*', description: 'Audio' },
  { uti: 'public.mp3', parent: ['public.audio'], mime: 'audio/mpeg', description: 'MP3 audio', ext: ['mp3'] },
  { uti: 'com.microsoft.waveform-audio', parent: ['public.audio'], mime: 'audio/wav', description: 'WAV audio', ext: ['wav'] },
  { uti: 'public.aiff-audio', parent: ['public.audio'], mime: 'audio/aiff', description: 'AIFF audio', ext: ['aif', 'aiff', 'aifc'] },
  { uti: 'com.apple.m4a-audio', parent: ['public.audio'], mime: 'audio/mp4', description: 'MPEG-4 audio', ext: ['m4a', 'm4b', 'm4r'] },
  { uti: 'public.aac-audio', parent: ['public.audio'], mime: 'audio/aac', description: 'AAC audio', ext: ['aac', 'adts'] },
  { uti: 'org.xiph.ogg-audio', parent: ['public.audio'], mime: 'audio/ogg', description: 'OGG audio', ext: ['ogg', 'oga'] },
  { uti: 'org.xiph.opus', parent: ['public.audio'], mime: 'audio/ogg', description: 'Opus audio', ext: ['opus'] },
  { uti: 'org.xiph.flac', parent: ['public.audio'], mime: 'audio/flac', description: 'FLAC audio', ext: ['flac'] },
  { uti: 'org.webmproject.weba', parent: ['public.audio'], mime: 'audio/webm', description: 'WebM audio', ext: ['weba'] },
  { uti: 'com.microsoft.wma', parent: ['public.audio'], mime: 'audio/x-ms-wma', description: 'Windows Media audio', ext: ['wma'] },
  { uti: 'public.midi-audio', parent: ['public.audio'], mime: 'audio/midi', description: 'MIDI audio', ext: ['mid', 'midi'] },
  { uti: 'com.apple.coreaudio-format', parent: ['public.audio'], mime: 'audio/x-caf', description: 'Core Audio file', ext: ['caf'] },
  { uti: 'com.sun.au-audio', parent: ['public.audio'], mime: 'audio/basic', description: 'Au audio', ext: ['au'] },
  { uti: 'org.3gpp.amr', parent: ['public.audio'], mime: 'audio/amr', description: 'AMR audio', ext: ['amr'] },
  { uti: 'org.matroska.mka', parent: ['public.audio'], mime: 'audio/x-matroska', description: 'Matroska audio', ext: ['mka'] },
  { uti: 'public.movie', parent: ['public.data'], mime: 'video/*', description: 'Movie' },
  { uti: 'public.mpeg-4', parent: ['public.movie'], mime: 'video/mp4', description: 'MPEG-4 movie', ext: ['mp4', 'm4v'] },
  { uti: 'com.apple.quicktime-movie', parent: ['public.movie'], mime: 'video/quicktime', description: 'QuickTime movie', ext: ['mov', 'qt'] },
  { uti: 'org.webmproject.webm', parent: ['public.movie'], mime: 'video/webm', description: 'WebM movie', ext: ['webm'] },
  { uti: 'org.matroska.mkv', parent: ['public.movie'], mime: 'video/x-matroska', description: 'Matroska video', ext: ['mkv'] },
  { uti: 'com.microsoft.avi', parent: ['public.movie'], mime: 'video/x-msvideo', description: 'AVI video', ext: ['avi'] },
  { uti: 'com.microsoft.wmv', parent: ['public.movie'], mime: 'video/x-ms-wmv', description: 'Windows Media video', ext: ['wmv', 'asf'] },
  { uti: 'public.mpeg', parent: ['public.movie'], mime: 'video/mpeg', description: 'MPEG video', ext: ['mpg', 'mpeg', 'm1v'] },
  { uti: 'public.mpeg-2-video', parent: ['public.movie'], mime: 'video/mpeg', description: 'MPEG-2 video', ext: ['m2v', 'vob'] },
  { uti: 'public.mpeg-2-transport-stream', parent: ['public.movie'], mime: 'video/mp2t', description: 'MPEG-2 transport stream', ext: ['ts', 'm2ts', 'mts'] },
  { uti: 'org.xiph.ogv', parent: ['public.movie'], mime: 'video/ogg', description: 'OGG video', ext: ['ogv'] },
  { uti: 'org.3gpp', parent: ['public.movie'], mime: 'video/3gpp', description: '3GPP movie', ext: ['3gp'] },
  { uti: 'org.3gpp2', parent: ['public.movie'], mime: 'video/3gpp2', description: '3GPP2 movie', ext: ['3g2'] },
  { uti: 'com.adobe.flash-video', parent: ['public.movie'], mime: 'video/x-flv', description: 'Flash video', ext: ['flv', 'f4v'] },
  { uti: 'public.dv-movie', parent: ['public.movie'], mime: 'video/x-dv', description: 'Digital video', ext: ['dv'] },
  { uti: 'com.adobe.pdf', parent: ['public.data'], mime: 'application/pdf', description: 'PDF document', ext: ['pdf'] },
  { uti: 'public.archive', parent: ['public.data'], mime: 'application/octet-stream', description: 'Archive' },
  { uti: 'public.zip-archive', parent: ['public.archive'], mime: 'application/zip', description: 'ZIP archive', ext: ['zip'] },
  { uti: 'org.tiny.disk-image', parent: ['public.data'], mime: 'application/x-tiny-image', description: 'Pear disk image', ext: ['tinyimg'] },
]

const MAGIC: Array<{ bytes: number[]; uti: string }> = [
  { bytes: [0x89, 0x50, 0x4e, 0x47], uti: 'public.png' },
  { bytes: [0xff, 0xd8, 0xff], uti: 'public.jpeg' },
  { bytes: [0x47, 0x49, 0x46, 0x38], uti: 'com.compuserve.gif' },
  { bytes: [0x25, 0x50, 0x44, 0x46], uti: 'com.adobe.pdf' },
  { bytes: [0x50, 0x4b, 0x03, 0x04], uti: 'public.zip-archive' },
]
/** How many leading bytes `sniff` looks at. */
export const SNIFF_BYTES = 16

/** The registry. Apps add extensions through their manifests; the first definition of an extension wins. */
export class TypeRegistry {
  private byUti = new Map<string, Def>()
  private byExt = new Map<string, string>()
  /** Who defined what, so conflicts can be shown to the user. The system (`null`) always wins over apps. */
  private claims = new Map<string, Array<{ uti: string; appId: string | null }>>()
  private owners = new Map<string, string | null>()
  private overrides = new Map<string, string>()
  private clashes: TypeConflict[] = []

  constructor() {
    for (const d of DEFS) this.define(d)
  }

  private define(d: Def): void {
    this.byUti.set(d.uti, d)
    for (const e of d.ext ?? []) {
      if (!this.byExt.has(e)) this.byExt.set(e, d.uti)
      if (!this.claims.has(e)) this.claims.set(e, [{ uti: d.uti, appId: null }])
    }
  }

  /**
   * Map an extension to a UTI an app declared. A UTI nobody defined becomes a plain data type. Returns false on conflict.
   * The system's own mappings win; between apps the first one wins unless the user chose with `setOverride`.
   */
  declare(ext: string, uti: string, appId: string | null = null): boolean {
    ext = ext.toLowerCase()
    const list = this.claims.get(ext) ?? []
    if (!list.some((c) => c.uti === uti && c.appId === appId)) list.push({ uti, appId })
    this.claims.set(ext, list)
    if (this.overrides.get(ext) === uti && this.byUti.has(uti)) {
      this.byExt.set(ext, uti)
      return true
    }
    if (this.byExt.has(ext)) {
      const same = this.byExt.get(ext) === uti
      if (!same) this.noteClash(ext)
      return same
    }
    if (!this.byUti.has(uti)) this.define({ uti, parent: ['public.data'], mime: 'application/octet-stream', description: uti })
    this.byExt.set(ext, uti)
    return true
  }

  /**
   * An app defines a type of its own: `uti` with the types it conforms to. A name the system (or an earlier app)
   * already defined is not replaced; the claim is recorded as a conflict. Parents the registry does not know are dropped.
   */
  defineType(def: { uti: string; conformsTo?: string[]; mime?: string; description?: string; ext?: string[] }, appId: string): boolean {
    if (this.byUti.has(def.uti)) {
      const keeper = this.owners.get(def.uti) ?? null
      if (keeper !== appId) this.clashes.push({ ext: null, uti: def.uti, claims: [{ uti: def.uti, appId: keeper }, { uti: def.uti, appId }], kept: keeper })
      return keeper === appId
    }
    const parent = (def.conformsTo ?? ['public.data']).filter((p) => this.byUti.has(p))
    this.define({ uti: def.uti, parent: parent.length ? parent : ['public.data'], mime: def.mime ?? 'application/octet-stream', description: def.description ?? def.uti, ext: [] })
    this.owners.set(def.uti, appId)
    for (const e of def.ext ?? []) this.declare(e, def.uti, appId)
    return true
  }

  private noteClash(ext: string): void {
    const claims = this.claims.get(ext) ?? []
    if (new Set(claims.map((c) => c.uti)).size < 2) return
    const kept = this.byExt.get(ext)!
    this.clashes = this.clashes.filter((c) => c.ext !== ext)
    this.clashes.push({ ext, uti: kept, claims: [...claims], kept: claims.find((c) => c.uti === kept)?.appId ?? null })
  }

  conflicts(): TypeConflict[] {
    return this.clashes.map((c) => ({ ...c, claims: [...c.claims] }))
  }

  /** The user's choice for an extension; `null` goes back to install order. */
  setOverride(ext: string, uti: string | null): void {
    ext = ext.toLowerCase()
    if (uti === null) this.overrides.delete(ext)
    else this.overrides.set(ext, uti)
    const chosen = uti ?? this.claims.get(ext)?.[0]?.uti
    if (chosen && this.byUti.has(chosen)) this.byExt.set(ext, chosen)
    this.clashes = this.clashes.filter((c) => c.ext !== ext)
    this.noteClash(ext)
  }

  /** Forget extension mappings that came from apps (called with the registry rebuilt from the installed set). */
  reset(): void {
    this.byUti.clear()
    this.byExt.clear()
    this.claims.clear()
    this.owners.clear()
    this.clashes = []
    for (const d of DEFS) this.define(d)
  }

  /** `uti` and everything it conforms to, nearest first. */
  conformances(uti: string): string[] {
    const out: string[] = []
    const queue = [uti]
    while (queue.length) {
      const next = queue.shift()!
      if (out.includes(next)) continue
      out.push(next)
      queue.push(...(this.byUti.get(next)?.parent ?? []))
    }
    return out
  }

  info(uti: string, ext: string | null = null): TypeInfo {
    const def = this.byUti.get(uti) ?? this.byUti.get('public.data')!
    return { uti: def.uti, mime: def.mime, description: def.description, conformsTo: this.conformances(def.uti), ext }
  }

  fromExtension(ext: string | null): string | null {
    return ext ? (this.byExt.get(ext.toLowerCase()) ?? null) : null
  }

  private sniff(bytes: Uint8Array): string | null {
    return MAGIC.find((m) => m.bytes.every((b, i) => bytes[i] === b))?.uti ?? null
  }

  /** Type of a file: extension first, then magic bytes, then `public.data`. */
  classify(opts: { name: string; kind: 'file' | 'dir' | 'symlink'; head?: Uint8Array }): TypeInfo {
    const dot = opts.name.lastIndexOf('.')
    const ext = dot > 0 ? opts.name.slice(dot + 1).toLowerCase() : null
    if (opts.kind === 'symlink') return this.info('public.symlink', ext)
    if (opts.kind === 'dir') return this.info(ext === 'app' ? 'com.apple.application-bundle' : 'public.folder', ext)
    const uti = this.fromExtension(ext) ?? (opts.head ? this.sniff(opts.head) : null) ?? 'public.data'
    return this.info(uti, ext)
  }
}
