import { tiny, textOf } from '@tiny/sdk'
import { HOME } from './util'

/** Finder's copy/cut: file references on the system pasteboard (`application/x-tiny-file-ref`), a file in the container if the pasteboard is unavailable. */
const REF = 'application/x-tiny-file-ref'
const FALLBACK = `${HOME}/Library/Containers/org.tiny.finder/clipboard.json`

export interface Clip {
  op: 'copy' | 'cut'
  paths: string[]
}

export async function writeClip(clip: Clip): Promise<void> {
  const data = JSON.stringify(clip)
  try {
    await tiny.service('tiny.clipboard', { op: 'write', board: 'general', items: [{ type: REF, data }, { type: 'text/plain', data: clip.paths.join('\n') }] })
    return
  } catch {
    // no pasteboard for this app: keep it in the container
  }
  await tiny.mkdir(FALLBACK.slice(0, FALLBACK.lastIndexOf('/')), { recursive: true }).catch(() => {})
  await tiny.writeFile(FALLBACK, new TextEncoder().encode(data))
}

function parse(text: string): Clip | null {
  try {
    const c = JSON.parse(text) as Clip
    return Array.isArray(c.paths) && c.paths.length && (c.op === 'copy' || c.op === 'cut') ? c : null
  } catch {
    return null
  }
}

export async function readClip(): Promise<Clip | null> {
  try {
    const r = await tiny.service<{ items?: Array<{ type: string; data: unknown }> }>('tiny.clipboard', { op: 'read', board: 'general', types: [REF] })
    const item = r?.items?.find((i) => i.type === REF)
    if (!item) return null
    return parse(typeof item.data === 'string' ? item.data : textOf(item.data as Uint8Array))
  } catch {
    // fall through to the container file
  }
  try {
    return parse(textOf(await tiny.readFile(FALLBACK)))
  } catch {
    return null
  }
}

export async function clearClip(): Promise<void> {
  await tiny.service('tiny.clipboard', { op: 'clear', board: 'general' }).catch(() => {})
  await tiny.unlink(FALLBACK).catch(() => {})
}
