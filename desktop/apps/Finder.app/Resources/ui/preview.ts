import { tiny, escapeHtml, textOf, formatBytes } from '@tiny/sdk'
import { bus } from './bus'
import { $ } from './dom'
import { fillIcon } from './icons'
import { selectedEntries, st, type Entry } from './state'
import { dateText, extOf, IMAGE_MIME } from './util'

let blobUrl = ''

async function firstBytes(path: string, n: number): Promise<Uint8Array> {
  const fd = await tiny.open(path, 0)
  try {
    return (await tiny.read(fd, n)) ?? new Uint8Array()
  } finally {
    await tiny.close(fd)
  }
}

async function body(e: Entry): Promise<string> {
  const ext = extOf(e.name)
  if (IMAGE_MIME[ext] && e.size < 20e6) {
    blobUrl = URL.createObjectURL(new Blob([(await tiny.readFile(e.path)) as BlobPart], { type: IMAGE_MIME[ext] }))
    return `<img class="pv-img" alt="${escapeHtml(e.name)}" src="${blobUrl}">`
  }
  if (!e.isDir && !e.isApp) {
    const bytes = await firstBytes(e.path, 100_000).catch(() => new Uint8Array())
    if (bytes.length && !bytes.subarray(0, 4096).includes(0)) return `<pre class="pv-text selectable">${escapeHtml(textOf(bytes))}${e.size > bytes.length ? '\n…' : ''}</pre>`
  }
  return `<div class="pv-card"><img class="thumb big" alt="" data-icon><div>${escapeHtml(e.kindText)}</div><div class="dim">${e.isDir ? '' : formatBytes(e.size) + ' · '}${dateText(e.mtime)}</div></div>`
}

export async function renderPreview(): Promise<void> {
  const box = $('preview')
  box.hidden = !st.quickLook
  if (!st.quickLook) return
  const e = selectedEntries().pop() ?? st.entries.find((x) => x.path === st.cursor)
  if (blobUrl) URL.revokeObjectURL(blobUrl)
  blobUrl = ''
  if (!e) {
    box.innerHTML = '<div class="pv-card dim">Select an item to preview</div>'
    return
  }
  const content = await body(e)
  if (!st.quickLook) return
  box.setAttribute('aria-label', `Quick Look: ${e.name}`)
  box.innerHTML = `<div class="pv-head"><strong>${escapeHtml(e.name)}</strong><button class="plain" data-close aria-label="Close preview">✕</button></div><div class="pv-body">${content}</div>`
  const icon = box.querySelector<HTMLImageElement>('img[data-icon]')
  if (icon) fillIcon(icon, e)
}

export function toggleQuickLook(): void {
  st.quickLook = !st.quickLook
  void renderPreview()
}

export function initPreview(): void {
  $('preview').addEventListener('click', (ev) => {
    if ((ev.target as HTMLElement).closest('[data-close]')) toggleQuickLook()
  })
  bus.on('selection', () => st.quickLook && void renderPreview())
  bus.on('location', () => void renderPreview())
}
