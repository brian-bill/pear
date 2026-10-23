import { dirname, joinPath, tiny } from '@tiny/sdk'

export const IMAGE_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
}
const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
export const isImage = (name: string) => name.includes('.') && extOf(name) in IMAGE_EXT
export const mimeOf = (name: string) => IMAGE_EXT[extOf(name)] ?? 'application/octet-stream'

/** The images in the folder of `path`, by name (the way Finder sorts), `path` included. */
export async function siblings(path: string): Promise<string[]> {
  try {
    const entries = await tiny.readdir(dirname(path))
    const names = entries.filter((e) => e.kind !== 'dir' && isImage(e.name)).map((e) => e.name)
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    const list = names.map((n) => joinPath(dirname(path), n))
    return list.includes(path) ? list : [path]
  } catch {
    return [path] // a folder we may not list: the one file
  }
}
