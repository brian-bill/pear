import { dirname, joinPath, tiny } from '@tiny/sdk'

/// Audio file types Music claims (`contracts/launch-services.md`): extension, then the MIME a decoder expects.
export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff',
  m4a: 'audio/mp4', m4b: 'audio/mp4', m4r: 'audio/mp4', aac: 'audio/aac', adts: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  wma: 'audio/x-ms-wma', mid: 'audio/midi', midi: 'audio/midi', caf: 'audio/x-caf', au: 'audio/basic',
  amr: 'audio/amr', mka: 'audio/x-matroska',
}
export const FILTERS = [{ name: 'Audio', ext: Object.keys(AUDIO_MIME) }]

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
export const isAudio = (name: string) => name.includes('.') && extOf(name) in AUDIO_MIME
export const mimeOf = (name: string) => AUDIO_MIME[extOf(name)] ?? 'application/octet-stream'
export const descriptionOf = (name: string) => {
  const mime = AUDIO_MIME[extOf(name)]
  return mime ? `${mime.split('/')[1]?.toUpperCase() ?? extOf(name).toUpperCase()} audio` : 'unknown audio'
}

/** The audio in the folder of `path`, by name (the way Finder sorts), `path` included. */
export async function siblings(path: string): Promise<string[]> {
  try {
    const entries = await tiny.readdir(dirname(path))
    const names = entries.filter((e) => e.kind !== 'dir' && isAudio(e.name)).map((e) => e.name)
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    const list = names.map((n) => joinPath(dirname(path), n))
    return list.includes(path) ? list : [path]
  } catch {
    return [path] // a folder we may not list: the one file
  }
}
