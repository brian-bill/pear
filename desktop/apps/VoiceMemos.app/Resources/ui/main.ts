// Voice Memos: a memo list in ~/Music/Voice Memos. Records (when the browser lets the window at
// the microphone), imports audio with the Open panel, plays through `tiny.audio`'s mixer (the
// engine is in `play.ts`, modelled on Music's), and renames/trashes memos on disk.

import { basename, joinPath, tiny } from '@tiny/sdk'
import { decodeAudio, encodeWav, fmtTime } from './wav'
import * as player from './play'
import { Recorder, micStream } from './record'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const HOME = '/Users/pear'
const LIB = `${HOME}/Music/Voice Memos`
const TRASH = `${HOME}/.Trash` // trash wants the destination folder, as Notes and Finder pass it
/** Types an imported file may carry. The library's own recordings are .wav; other imports keep theirs. */
const AUDIO_EXTS = ['wav', 'aif', 'aiff', 'aifc', 'm4a', 'mp3', 'aac', 'adts', 'ogg', 'oga', 'opus', 'flac', 'weba', 'caf', 'au', 'amr']

/** The honest answer when the browser refuses the sandbox the microphone. Shown unedited. */
const MIC_NOTE = "Microphone isn't available in this shell yet"

interface Memo {
  path: string
  name: string // without the extension
  mtime: number
  /** Decoded once per listing; -1 when the browser cannot decode the file. */
  secs: number | null
}

let memos: Memo[] = []
let selected: Memo | null = null
let noteMsg = '' // '' hides #note
let startingRec = false // between the press and the mic answer

const rec = new Recorder()

const extOf = (name: string) => name.slice(name.lastIndexOf('.') + 1).toLowerCase()
const stemOf = (name: string) => (name.includes('.') ? name.slice(0, name.lastIndexOf('.')) : name)
const durText = (m: Memo) => (m.secs === null ? '' : m.secs < 0 ? '—' : fmtTime(m.secs))
const fmtDate = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

const PlaySvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>'
const StopSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" fill="currentColor"/></svg>'
const RecSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="7" fill="currentColor"/></svg>'
const StopRecSvg = '<svg class="stoprec" viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>'

const setNote = (text: string) => {
  noteMsg = text
  paint()
}

// ---- library

/** The folder on open; ENOENT of a parent is healed by the recursive mkdir, EACCES surfaces later. */
async function ensureLib(): Promise<void> {
  try {
    await tiny.mkdir(LIB, { recursive: true })
  } catch {
    // exists or held by someone else: readdir in `refresh` has the final say
  }
}

async function refresh(): Promise<void> {
  let names: Array<{ name: string; kind: string }> = []
  try {
    names = await tiny.readdir(LIB)
  } catch {
    await ensureLib()
    try {
      names = await tiny.readdir(LIB)
    } catch {
      setNote('The Voice Memos folder could not be read.')
      return
    }
  }
  const rows: Memo[] = []
  for (const entry of names.filter((n) => n.kind !== 'dir' && AUDIO_EXTS.includes(extOf(n.name)))) {
    const path = joinPath(LIB, entry.name)
    let mtime = 0
    try {
      mtime = (await tiny.stat(path)).mtime
    } catch {
      continue // renamed or removed between readdir and stat
    }
    const kept = memos.find((m) => m.path === path && m.mtime === mtime)
    rows.push(kept ?? { path, name: stemOf(entry.name), mtime, secs: null })
  }
  rows.sort((a, b) => b.mtime - a.mtime || a.name.localeCompare(b.name))
  memos = rows
  if (selected && !memos.some((m) => m.path === selected?.path)) selected = null
  for (const m of memos) if (m.secs === null) void fillDuration(m)
  paint()
}

/** Decode the duration once per (path, mtime): the row fills in when the bytes are through. */
async function fillDuration(m: Memo): Promise<void> {
  try {
    const pcm = await decodeAudio(await tiny.readFile(m.path))
    if (!memos.includes(m)) return // renamed/removed/gone while decoding
    m.secs = pcm.data.length / (pcm.rate || 1)
  } catch {
    if (memos.includes(m)) m.secs = -1 // listed, but with no duration to show
  }
  paint()
}

async function unusedName(name: string): Promise<string> {
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; n < 1000; n++) {
    const candidate = n === 1 ? `${stem}${ext}` : `${stem} ${n}${ext}`
    try {
      if (!(await tiny.exists(joinPath(LIB, candidate)))) return candidate
    } catch {
      return candidate // cannot ask: an overlap is the safer guess
    }
  }
  return `${stem} many${ext}`
}

// ---- actions

function select(m: Memo): void {
  selected = m
  paint()
}

async function importAudio(): Promise<void> {
  const picked = await tiny.dialogs.openFile({ title: 'Import audio', filters: [{ name: 'Audio', ext: AUDIO_EXTS }] })
  if (!picked) return
  let lastPath: string | null = null
  for (const p of picked) {
    try {
      await ensureLib()
      const base = basename(p)
      const dot = base.lastIndexOf('.')
      const name = dot > 0 ? `${base.slice(0, dot)}.${extOf(base)}` : base
      const source = await tiny.readFile(p)
      const dest = joinPath(LIB, await unusedName(name))
      await tiny.writeFile(dest, source)
      lastPath = dest
    } catch (e) {
      await tiny.dialogs.alert({ title: 'Voice Memos', message: `“${basename(p)}” could not be imported.`, detail: (e as Error).message })
    }
  }
  await refresh()
  const newest = lastPath ? memos.find((m) => m.path === lastPath) : null
  if (newest) select(newest)
}

async function rename(m: Memo): Promise<void> {
  const value = await tiny.dialogs.prompt(`Rename “${m.name}”`, { value: m.name, button: 'Rename' })
  if (value === null) return
  const typed = value.trim()
  if (!typed) return
  const to = typed.toLowerCase().endsWith('.wav') ? typed : `${typed}.wav`
  const dest = joinPath(LIB, to)
  if (dest === m.path) {
    paint()
    return
  }
  try {
    if (await tiny.exists(dest)) throw new Error('that name is taken')
    await tiny.rename(m.path, dest)
  } catch (e) {
    await tiny.dialogs.alert({ title: 'Voice Memos', message: `The name “${typed}” could not be set.`, detail: (e as Error).message })
    return
  }
  await refresh()
  const now = memos.find((x) => x.path === dest)
  if (now) select(now)
}

async function removeMemo(): Promise<void> {
  const m = selected
  if (!m) return
  if (!(await tiny.dialogs.confirm(`Delete “${m.name}”?`, { danger: true }))) return
  player.pause() // if it was sounding, it stops first
  try {
    await tiny.trash(m.path, TRASH)
  } catch (e) {
    await tiny.dialogs.alert({ title: 'Voice Memos', message: `“${m.name}” could not be deleted.`, detail: (e as Error).message })
    return
  }
  await refresh()
}

async function togglePlay(): Promise<void> {
  if (player.active()) {
    player.stop()
    return
  }
  const m = selected
  if (!m) return
  let data
  try {
    data = await decodeAudio(await tiny.readFile(m.path))
  } catch (e) {
    setNote(`“${m.name}” could not be played (${(e as Error).message}).`)
    return
  }
  player.start(data, 0, onTickUI, (why) => {
    if (why) setNote(`Playback stopped: ${why}`)
    else paint()
  })
  paint()
}

function onTickUI(): void {
  if (player.active()) $('cur').textContent = fmtTime(player.elapsed())
}

// ---- record

async function toggleRecord(): Promise<void> {
  if (rec.running()) {
    await stopRecording()
    paint()
    return
  }
  startingRec = true
  paint()
  const stream = await micStream()
  startingRec = false
  if (!stream) {
    setNote(MIC_NOTE)
    return
  }
  setNote('')
  try {
    rec.start(stream)
  } catch (e) {
    setNote(`Recording could not start: ${(e as Error).message}`)
  }
  paint()
}

/** Save the capture as a 16-bit mono PCM WAV next to the others. */
async function stopRecording(): Promise<void> {
  const got = await rec.stop()
  if (!got || got.samples.length < 8) {
    setNote('Nothing was captured, so no memo was saved.')
    return
  }
  try {
    await ensureLib()
    const name = await unusedName('New Recording.wav')
    await tiny.writeFile(joinPath(LIB, name), encodeWav(got.samples, got.rate))
    await refresh()
    const saved = memos.find((m) => m.path === joinPath(LIB, name))
    if (saved) select(saved)
  } catch (e) {
    setNote(`Recording could not be saved: ${(e as Error).message}`)
  }
}

// ---- look

/** Row elements by path: reused across paints, so a selection repaint never breaks a double-click. */
const rowEls = new Map<string, HTMLButtonElement>()

function syncRow(row: HTMLButtonElement, m: Memo): void {
  row.className = `memo${selected === m ? ' sel' : ''}`
  row.title = m.path
  row.setAttribute('aria-selected', selected === m ? 'true' : 'false')
  const set = (cls: string, text: string) => {
    const el = row.querySelector<HTMLElement>(`.${cls}`)
    if (el && el.textContent !== text) el.textContent = text
  }
  set('name', m.name)
  set('dur', durText(m))
  set('date', fmtDate(m.mtime))
}

function renderRows(): void {
  const list = $<HTMLElement>('list')
  const alive = new Set(memos.map((m) => m.path))
  for (const [path, el] of rowEls) {
    if (alive.has(path)) continue
    el.remove()
    rowEls.delete(path)
  }
  for (const m of memos) {
    let row = rowEls.get(m.path)
    if (!row) {
      row = document.createElement('button')
      row.setAttribute('role', 'option')
      row.dataset.path = m.path
      for (const cls of ['name trim', 'dur', 'date']) {
        const span = document.createElement('span')
        span.className = cls
        row.append(span)
      }
      rowEls.set(m.path, row)
    }
    syncRow(row, m)
    const at = list.children[memos.indexOf(m)] // keep the list sorted without churning the row nodes
    if (at !== row) list.insertBefore(row, at ?? null)
  }
}

function paint(): void {
  renderRows()
  $<HTMLElement>('empty').hidden = memos.length > 0
  const note = $<HTMLElement>('note')
  note.textContent = noteMsg
  note.hidden = noteMsg === ''
  const recording = rec.running()
  const recBtn = $<HTMLButtonElement>('rec')
  recBtn.innerHTML = recording ? StopRecSvg : RecSvg
  recBtn.setAttribute('aria-label', recording ? 'Stop recording' : 'Record')
  recBtn.disabled = startingRec
  const on = player.active()
  const playBtn = $<HTMLButtonElement>('play')
  playBtn.innerHTML = on ? StopSvg : PlaySvg
  playBtn.setAttribute('aria-label', on ? 'Stop' : 'Play')
  playBtn.disabled = !selected
  if (!on) $('cur').textContent = '0:00'
  const title = selected ? `Voice Memos — ${selected.name}` : 'Voice Memos'
  void tiny.window.setTitle(title)
  void tiny.window.setMenus(menus())
}

function menus() {
  const hasSel = selected !== null
  return [
    { title: 'Voice Memos', items: [{ label: 'About Voice Memos', action: () => about() }] },
    {
      title: 'File',
      items: [
        { label: rec.running() ? 'Stop Recording' : 'New Recording', shortcut: 'Cmd+N', action: () => void toggleRecord() },
        { separator: true },
        { label: 'Import audio…', shortcut: 'Cmd+O', action: () => void importAudio() },
        { label: 'Close', action: () => void tiny.window.close() },
      ],
    },
    {
      title: 'Edit',
      items: [
        {
          label: 'Rename',
          action: () => {
            if (selected) void rename(selected)
          },
          disabled: !hasSel,
        },
        { label: 'Delete', shortcut: 'Cmd+Backspace', action: () => void removeMemo(), disabled: !hasSel },
      ],
    },
  ]
}

function about(): void {
  void tiny.dialogs.alert({
    title: 'Voice Memos',
    message: 'Voice Memos 1.0',
    detail: 'Record and play short memos. The files live in ~/Music/Voice Memos.',
  })
}

async function main(): Promise<void> {
  await tiny.ready
  $<HTMLButtonElement>('import').addEventListener('click', () => void importAudio())
  $<HTMLButtonElement>('rec').addEventListener('click', () => void toggleRecord())
  $('play').addEventListener('click', () => void togglePlay())
  // the rows float: handlers live on the list and look memos up by path, so they survive repaints
  const list = $<HTMLElement>('list')
  const rowOf = (e: Event): Memo | null => {
    const row = (e.target as HTMLElement).closest('button.memo')
    if (!(row instanceof HTMLElement)) return null
    return memos.find((m) => m.path === row.dataset.path) ?? null
  }
  list.addEventListener('click', (e) => {
    const m = rowOf(e)
    if (m) select(m)
  })
  list.addEventListener('dblclick', (e) => {
    const m = rowOf(e)
    if (m) void rename(m)
  })
  await refresh()
}

void main()
