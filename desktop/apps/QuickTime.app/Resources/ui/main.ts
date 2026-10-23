import { basename, dirname, formatBytes, tiny } from '@tiny/sdk'
import { FILTERS, isMedia, isVideo, mimeOf, siblings } from './media'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const stage = $('stage')
const video = $<HTMLVideoElement>('video')
const emptyEl = $('empty')
const helpEl = $('help')
const infoEl = $('info')
const playBtn = $('play') as HTMLButtonElement
const scrubEl = $<HTMLInputElement>('scrub')
const volEl = $<HTMLInputElement>('vol')
const prevBtn = $<HTMLButtonElement>('prev')
const nextBtn = $<HTMLButtonElement>('next')

const PlaySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>'
const PauseSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor"/></svg>'

/** What this window has: one movie (or song) at a time, its siblings for next/previous. */
const state = { path: null as string | null, folder: [] as string[], url: null as string | null, size: 0, mtime: 0, mime: '', audio: false }
let loadId = 0

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(Math.max(0, s) % 60)).padStart(2, '0')}`
const secs = () => (Number.isFinite(video.duration) ? video.duration : 0)

function paint(): void {
  const started = !video.paused && !video.ended
  const ready = Boolean(state.path) && video.readyState > 0
  playBtn.disabled = !state.path
  playBtn.innerHTML = started ? PauseSvg : PlaySvg
  playBtn.title = started ? 'Pause (Space)' : 'Play (Space)'
  playBtn.setAttribute('aria-label', started ? 'Pause' : 'Play')
  helpEl.hidden = !state.path || started
  scrubEl.disabled = !ready
  scrubEl.max = secs().toFixed(2)
  scrubEl.value = Math.min(Number(scrubEl.max), video.currentTime).toFixed(2)
  $('cur').textContent = fmt(video.currentTime)
  $('rest').textContent = `-${fmt(Math.max(0, secs() - video.currentTime))}`
  void updateMenus()
}

function showInfo(): void {
  if (!state.path) return
  const rows: Array<[string, string]> = [
    ['Name', basename(state.path)],
    ['Kind', state.mime],
    ['Size', formatBytes(state.size)],
    ['Modified', new Date(state.mtime).toLocaleString()],
    ['Where', dirname(state.path)],
  ]
  if (video.videoWidth) rows.splice(1, 0, ['Dimensions', `${video.videoWidth} × ${video.videoHeight}`])
  infoEl.replaceChildren(...rows.flatMap(([k, v]) => [Object.assign(document.createElement('dt'), { textContent: k }), Object.assign(document.createElement('dd'), { textContent: v })]))
  infoEl.hidden = false
}

async function updateMenus(): Promise<void> {
  const started = !video.paused && !video.ended
  await tiny.window.setMenus([
    { title: 'QuickTime Player', items: [{ label: 'Open…', shortcut: 'Cmd+O', action: () => void openDialog() }] },
    {
      title: 'Playback',
      items: [
        { label: started ? 'Pause' : 'Play', shortcut: 'Space', action: () => toggle() },
        { separator: true },
        { label: 'Next Media', shortcut: 'Cmd+ArrowRight', action: () => void step(1), disabled: state.folder.length < 2 },
        { label: 'Previous Media', shortcut: 'Cmd+ArrowLeft', action: () => void step(-1), disabled: state.folder.length < 2 },
      ],
    },
    { title: 'View', items: [{ label: infoEl.hidden ? 'Show Info' : 'Hide Info', shortcut: 'Cmd+I', action: () => (infoEl.hidden ? showInfo() : (infoEl.hidden = true)) }, { label: 'Toggle Full Window', shortcut: 'Cmd+F', action: () => void tiny.window.toggleMaximize() }] },
  ])
}

/** Play; if the browser refuses (no click in this window yet), show the "click to play" panel instead. */
async function startPlay(): Promise<void> {
  if (!state.path) return
  try {
    await video.play()
    helpEl.hidden = true
  } catch {
    helpEl.hidden = false
  }
  paint()
}

function toggle(): void {
  if (!state.path) {
    void openDialog()
    return
  }
  if (video.paused) void startPlay()
  else video.pause()
}

async function step(d: number): Promise<void> {
  if (state.folder.length < 2 || !state.path) return
  const i = (state.folder.indexOf(state.path) + d + state.folder.length) % state.folder.length
  void show(state.folder[i]!)
}

async function openDialog(): Promise<void> {
  const picked = await tiny.dialogs.openFile({ title: 'Open', startIn: state.path ? dirname(state.path) : undefined, filters: FILTERS })
  if (picked?.[0]) void show(picked[0], true)
}

/** Load a path into the element. `playIt` asks for sound the browser may refuse until a click lands. */
async function show(p: string, playIt = true): Promise<void> {
  const id = ++loadId
  if (!isMedia(p)) {
    await tiny.dialogs.alert({ message: `“${basename(p)}” is not media QuickTime Player can open.` })
    return
  }
  let url: string | null = null
  try {
    const [bytes, st] = await Promise.all([tiny.readFile(p), tiny.stat(p)])
    if (id !== loadId) return
    video.pause()
    Object.assign(state, { path: p, size: st.size, mtime: st.mtime, mime: mimeOf(p), audio: !isVideo(p) })
    state.folder = await siblings(p).catch(() => [p])
    url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: state.mime }))
    video.src = url
    await new Promise<void>((resolve, reject) => {
      const settle = (ok: boolean) => () => {
        if (id !== loadId) return resolve() // a superseded load just unwinds
        if (ok) resolve()
        else reject(new Error(`no decoder for ${state.mime}`))
      }
      video.onloadedmetadata = settle(true)
      video.onerror = settle(false)
    })
    if (id !== loadId) {
      URL.revokeObjectURL(url)
      return
    }
    if (state.url) URL.revokeObjectURL(state.url)
    state.url = url
    emptyEl.hidden = true
    video.hidden = false
    void tiny.window.setTitle(basename(p))
    renderStepButtons()
    if (playIt) await startPlay()
    paint()
  } catch (e) {
    if (url) URL.revokeObjectURL(url)
    if (id !== loadId) return
    state.path = null
    state.folder = []
    video.removeAttribute('src')
    video.load()
    emptyEl.hidden = false
    helpEl.hidden = true
    void tiny.window.setTitle('QuickTime Player') // nothing loaded any more, so the default name
    renderStepButtons()
    const why = (e as Error).message
    const noDecoder = /no decoder/.test(why)
    await tiny.dialogs.alert({
      message: `“${basename(p)}” could not be opened.`,
      detail: noDecoder ? `The browser has no decoder for ${(p.slice(p.lastIndexOf('.') + 1) || 'this').toUpperCase()} media.` : (e as Error).message,
    })
    paint()
  }
}

function renderStepButtons(): void {
  prevBtn.disabled = nextBtn.disabled = state.folder.length < 2
}

// ---- events

let seeking = false

video.addEventListener('timeupdate', () => {
  if (!seeking) paint()
})
video.addEventListener('pause', paint)
video.addEventListener('play', paint)
video.addEventListener('loadedmetadata', paint)
video.addEventListener('ended', () => (state.folder.length > 1 ? void step(1) : paint()))
video.addEventListener('volumechange', () => (volEl.value = String(video.volume)))
video.volume = Number(volEl.value) || 1

scrubEl.addEventListener('input', () => (seeking = true))
scrubEl.addEventListener('change', () => {
  seeking = false
  const frac = Number(scrubEl.value) / Math.max(Number(scrubEl.max), 0.01)
  video.currentTime = frac * Math.max(secs(), video.currentTime)
  if (video.paused) paint()
})
volEl.addEventListener('input', () => {
  video.volume = Number(volEl.value)
})
$('helpplay').addEventListener('click', (e) => {
  e.stopPropagation() // the stage click would toggle again
  void startPlay()
})
playBtn.addEventListener('click', () => toggle())
prevBtn.addEventListener('click', () => void step(-1))
nextBtn.addEventListener('click', () => void step(1))
stage.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.info')) return
  stage.focus()
  toggle()
})
stage.addEventListener('dblclick', () => void tiny.window.toggleMaximize())
addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === ' ') {
    e.preventDefault()
    toggle()
  } else if (e.key === 'ArrowRight') {
    e.preventDefault()
    video.currentTime = Math.min(secs(), video.currentTime + 5)
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault()
    video.currentTime = Math.max(0, video.currentTime - 5)
  }
})

// ---- app wiring

async function main(): Promise<void> {
  await tiny.ready
  const saved = tiny.app.state as { path?: string | null } | undefined | null
  const arg = tiny.app.args[0] ?? null
  tiny.app.onOpenFile((p) => void show(p, true))
  tiny.app.onSaveState(() => ({ path: state.path }))
  if (arg) await show(arg, true)
  else if (saved?.path) await show(saved.path, false) // a restored session sits paused, like TextEdit reopening a draft
  paint()
  stage.focus()
}

void main()
