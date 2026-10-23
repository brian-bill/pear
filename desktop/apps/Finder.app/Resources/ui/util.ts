import { tiny, basename, dirname, joinPath } from '@tiny/sdk'

export const HOME = '/Users/pear'
export const TRASH = `${HOME}/.Trash`
export const SAVED_DIR = `${HOME}/Library/Saved Searches`
export const APPS = '/Applications'

export const isInTrash = (p: string) => p === TRASH || p.startsWith(`${TRASH}/`)
export const isAppName = (n: string) => n.endsWith('.app')

export function splitExt(name: string): [string, string] {
  const i = name.lastIndexOf('.')
  return i > 0 ? [name.slice(0, i), name.slice(i)] : [name, '']
}

/** `report.txt` -> `report copy.txt` -> `report copy 2.txt`, skipping names in `taken`. */
export function uniqueName(name: string, taken: Set<string>, suffix = ' copy'): string {
  if (!taken.has(name)) return name
  const [stem, ext] = splitExt(name)
  for (let n = 1; ; n++) {
    const candidate = `${stem}${suffix}${n > 1 ? ` ${n}` : ''}${ext}`
    if (!taken.has(candidate)) return candidate
  }
}

export async function namesIn(dir: string): Promise<Set<string>> {
  return new Set((await tiny.readdir(dir)).map((e) => e.name))
}

/** A free name for `name` in `dir`, with `suffix` ("copy", "") before a counter. */
export async function freeName(dir: string, name: string, suffix = ' copy'): Promise<string> {
  return uniqueName(name, await namesIn(dir), suffix)
}

export const folderTitle = (p: string) => (p === '/' ? 'Macintosh HD' : basename(p))
export { basename, dirname, joinPath }

export const errText = (e: unknown) => (e as Error)?.message ?? String(e)
export const errCode = (e: unknown) => (e as { code?: string })?.code ?? ''

export function dateText(ms: number): string {
  if (!ms) return '--'
  return new Intl.DateTimeFormat(tiny.locale || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(ms)
}

export const sizeText = (n: number) => {
  if (n < 1000) return `${n} ${n === 1 ? 'byte' : 'bytes'}`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let u = -1
  while (v >= 1000 && u < units.length - 1) {
    v /= 1000
    u++
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[u]}`
}

export async function alertError(message: string, e: unknown): Promise<void> {
  await tiny.dialogs.alert({ message, detail: errText(e), danger: true })
}

/** Run `fn`, report a failure to the user, and say whether it worked. */
export async function attempt(message: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch (e) {
    await alertError(message, e)
    return false
  }
}

export const TAG_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const
export const TAG_HEX: Record<string, string> = { red: '#ff453a', orange: '#ff9f0a', yellow: '#ffd60a', green: '#30d158', blue: '#0a84ff', purple: '#bf5af2', gray: '#8e8e93' }
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

export function parseTags(v: string | null): string[] {
  return (v ?? '').split(',').map((t) => t.trim()).filter(Boolean)
}
export async function readTags(path: string): Promise<string[]> {
  try {
    return parseTags(await tiny.getxattr(path, 'user.tags'))
  } catch {
    return []
  }
}
export async function writeTags(path: string, tags: string[]): Promise<void> {
  const unique = [...new Set(tags)]
  if (unique.length) await tiny.setxattr(path, 'user.tags', unique.join(','))
  else await tiny.removexattr(path, 'user.tags').catch(() => {})
}

export const IMAGE_MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp' }
export const extOf = (name: string) => splitExt(name)[1].slice(1).toLowerCase()
