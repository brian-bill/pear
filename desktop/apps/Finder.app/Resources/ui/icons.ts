import { tiny } from '@tiny/sdk'
import type { Entry } from './state'
import { extOf } from './util'

const cache = new Map<string, Promise<string | null>>()

/** Folders and documents share an icon per type; app bundles and anything unusual are looked up by path. */
function keyFor(e: Pick<Entry, 'path' | 'name' | 'isApp' | 'isDir'>): string {
  if (e.isApp) return `app:${e.path}`
  if (e.isDir) return 'dir'
  const ext = extOf(e.name)
  return ext ? `ext:${ext}` : 'file'
}

/** The icon Desktop picks for an entry, as a data URL (cached by kind). */
export function iconFor(e: Pick<Entry, 'path' | 'name' | 'isApp' | 'isDir'>): Promise<string | null> {
  const key = keyFor(e)
  let p = cache.get(key)
  if (!p) {
    p = tiny.shell.icon(e.path).then((i) => i.url).catch(() => null)
    cache.set(key, p)
  }
  return p
}

/** Put the icon into `img` once known. */
export function fillIcon(img: HTMLImageElement, e: Pick<Entry, 'path' | 'name' | 'isApp' | 'isDir'>): void {
  void iconFor(e).then((url) => {
    if (url && img.isConnected) img.src = url
    else if (!url) img.classList.add('missing')
  })
}

export function forgetIcons(): void {
  cache.clear()
}

const G: Record<string, string> = {
  home: 'M3 11l9-7 9 7M5 10v10h5v-6h4v6h5V10',
  desktop: 'M3 5h18v11H3zM8 20h8M12 16v4',
  doc: 'M6 3h8l5 5v13H6zM14 3v5h5',
  download: 'M12 4v11M7 11l5 5 5-5M5 20h14',
  apps: 'M5 18l7-14 7 14M8 14h8M7 18h10',
  disk: 'M3 14h18v5H3zM3 14l3-8h12l3 8M17 17h.01',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6',
  folder: 'M3 6h6l2 2h10v11H3z',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zM15.5 15.5L20 20',
  smart: 'M3 6h6l2 2h10v11H3zM12 11v5M9.5 13.5h5',
}

export function glyph(name: string): string {
  return `<svg class="glyph" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="${G[name] ?? G.folder}"/></svg>`
}
