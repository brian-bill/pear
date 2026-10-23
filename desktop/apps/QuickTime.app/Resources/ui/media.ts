import { dirname, joinPath, tiny } from '@tiny/sdk'

/// Media file types QuickTime claims (`contracts/launch-services.md`): video containers and, as a
/// friendly fallback for Open With, audio files (same element, artwork instead of a picture).
export const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', qt: 'video/quicktime', webm: 'video/webm',
  mkv: 'video/x-matroska', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', asf: 'video/x-ms-wmv',
  mpg: 'video/mpeg', mpeg: 'video/mpeg', m1v: 'video/mpeg', m2v: 'video/mpeg', vob: 'video/mpeg',
  ts: 'video/mp2t', m2ts: 'video/mp2t', mts: 'video/mp2t', ogv: 'video/ogg',
  '3gp': 'video/3gpp', '3g2': 'video/3gpp2', flv: 'video/x-flv', f4v: 'video/x-flv', dv: 'video/x-dv',
}
export const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', aif: 'audio/aiff', aiff: 'audio/aiff', aifc: 'audio/aiff',
  m4a: 'audio/mp4', m4b: 'audio/mp4', m4r: 'audio/mp4', aac: 'audio/aac', adts: 'audio/aac',
  ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  wma: 'audio/x-ms-wma', mid: 'audio/midi', midi: 'audio/midi', caf: 'audio/x-caf', au: 'audio/basic',
  amr: 'audio/amr', mka: 'audio/x-matroska',
}
export const MIME: Record<string, string> = { ...VIDEO_MIME, ...AUDIO_MIME }
export const VIDEO_EXT = Object.keys(VIDEO_MIME)
export const FILTERS = [
  { name: 'Video', ext: VIDEO_EXT },
  { name: 'Audio', ext: Object.keys(AUDIO_MIME) },
]

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
export const isVideo = (name: string) => name.includes('.') && extOf(name) in VIDEO_MIME
export const isAudio = (name: string) => name.includes('.') && extOf(name) in AUDIO_MIME
export const isMedia = (name: string) => isVideo(name) || isAudio(name)
export const mimeOf = (name: string) => VIDEO_MIME[extOf(name)] ?? AUDIO_MIME[extOf(name)] ?? 'application/octet-stream'
export const descriptionOf = (name: string) => {
  const mime = VIDEO_MIME[extOf(name)]
  if (mime) return `${mime.split('/')[1]?.toUpperCase() ?? extOf(name).toUpperCase()} movie`
  const audio = AUDIO_MIME[extOf(name)]
  return audio ? `${audio.split('/')[1]?.toUpperCase() ?? extOf(name).toUpperCase()} audio` : 'unknown media'
}

/** The media in the folder of `path`, by name (the way Finder sorts), `path` included. */
export async function siblings(path: string): Promise<string[]> {
  try {
    const entries = await tiny.readdir(dirname(path))
    const names = entries.filter((e) => e.kind !== 'dir' && isMedia(e.name)).map((e) => e.name)
    names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    const list = names.map((n) => joinPath(dirname(path), n))
    return list.includes(path) ? list : [path]
  } catch {
    return [path] // a folder we may not list: the one file
  }
}
