import { tiny, bytesOf } from '@tiny/sdk'
import type { LogStore } from './store'
import { LEVELS, type LogEntry, type Pane } from './types'
import { clock, copyText, dateTime, el, errText, esc } from './util'
import { VList } from './vlist'

const ROW = 22

export interface LogPane extends Pane {
  /** Filters changed from outside (the sidebar). */
  refilter(): void
  /** Set text in the search field and filter by it. */
  search(text: string): void
}

export function logPane(store: LogStore, onFacets: () => void): LogPane {
  const root = el('div', 'pane')
  root.innerHTML = `
    <div class="toolbar">
      <input type="search" id="q" class="grow" placeholder="Search  (subsystem:  level:  category:  app:  pid:)" aria-label="Search log">
      <select id="level" aria-label="Minimum level">${LEVELS.map((l, i) => `<option value="${l}">${i ? `${l[0]!.toUpperCase()}${l.slice(1)} and above` : 'All levels'}</option>`).join('')}</select>
      <select id="proc" aria-label="Process or app"></select>
    </div>
    <div class="toolbar sub">
      <button id="pause" aria-pressed="false">Pause</button>
      <label class="row"><input type="checkbox" id="follow" checked> Follow</label>
      <span class="spacer"></span>
      <label class="row" title="Private messages are shown as &lt;private&gt; in exports unless this is on"><input type="checkbox" id="priv"> Include private</label>
      <button id="export">Export...</button>
      <button id="clear" class="danger">Clear...</button>
    </div>
    <div class="head logcols"><span>Time</span><span>Level</span><span>Subsystem</span><span>Category</span><span>Message</span><span>Process</span></div>
    <div class="listarea"></div>
    <div class="detail" hidden></div>
    <div class="status"><span id="count" aria-live="off"></span><span class="grow"></span><span id="note" role="status"></span></div>`
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  const detail = $('.detail')
  let selected: number | null = null // entry id
  let follow = true

  const list = new VList<LogEntry>(
    ROW,
    (e) => `<span class="mono dim">${clock(e.time)}</span><span class="lv">${e.level}</span><span title="${esc(e.subsystem)}">${esc(e.subsystem)}</span><span class="dim">${esc(e.category)}</span><span class="msg">${esc(e.message.replace(/\s+/g, ' '))}</span><span class="dim">${esc(e.appId ?? (e.pid ? `pid ${e.pid}` : 'system'))}${e.appId && e.pid ? ` (${e.pid})` : ''}</span>`,
    (e) => `logcols level-${e.level}${e.id === selected ? ' selected' : ''}`,
  )
  list.el.setAttribute('role', 'list')
  list.el.setAttribute('aria-label', 'Log messages')
  $('.listarea').append(list.el)

  const note = (t: string) => {
    $('#note').textContent = t
    setTimeout(() => $('#note').textContent === t && ($('#note').textContent = ''), 5000)
  }

  function updateCount(): void {
    $('#count').textContent = `${store.shown.length} of ${store.all.length} messages${store.paused ? ' (paused)' : ''}`
  }

  function procOptions(): void {
    const sel = $<HTMLSelectElement>('#proc')
    const keys = [...store.procs.keys()].sort()
    sel.innerHTML = `<option value="">All processes</option>${keys.map((k) => `<option value="${esc(k)}">${esc(k)}</option>`).join('')}`
    sel.value = store.filter.proc ?? ''
  }

  function draw(): void {
    list.set(store.shown)
    updateCount()
    if (follow) list.scrollToBottom()
  }

  function pick(e: LogEntry | undefined): void {
    selected = e?.id ?? null
    list.schedule()
    if (!e) return void (detail.hidden = true)
    detail.hidden = false
    const rows: Array<[string, string]> = [['Time', dateTime(e.time)], ['Level', e.level], ['Subsystem', e.subsystem], ['Category', e.category], ['Process', `${e.appId ?? 'system'}${e.pid ? `, pid ${e.pid}` : ''}`]]
    detail.innerHTML = `<div class="row"><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl><span class="grow"></span><span class="stack"><button id="copyrow">Copy Row</button><button id="copymsg">Copy Message</button></span></div>
      <div class="label">Message</div><pre class="selectable" id="dmsg">${esc(e.message)}</pre>
      ${e.data !== undefined ? `<div class="label">Data</div><pre class="selectable" id="ddata">${esc(JSON.stringify(e.data, null, 2) ?? '')}</pre>` : ''}`
    detail.querySelector('#copyrow')!.addEventListener('click', async () => note((await copyText(JSON.stringify(e))) ? 'Row copied' : 'Could not copy'))
    detail.querySelector('#copymsg')!.addEventListener('click', async () => note((await copyText(e.message)) ? 'Message copied' : 'Could not copy'))
  }

  list.onPick = (i) => pick(store.shown[i])
  list.onUserScroll = (atBottom) => {
    follow = atBottom
    $<HTMLInputElement>('#follow').checked = atBottom
  }
  list.el.addEventListener('keydown', (ev) => {
    if (ev.key !== 'ArrowDown' && ev.key !== 'ArrowUp') return
    ev.preventDefault()
    const cur = store.shown.findIndex((e) => e.id === selected)
    const next = Math.max(0, Math.min(store.shown.length - 1, cur + (ev.key === 'ArrowDown' ? 1 : -1)))
    pick(store.shown[next])
    list.reveal(next)
  })

  const refilter = () => {
    store.refilter()
    draw()
  }
  $<HTMLInputElement>('#q').addEventListener('input', (e) => {
    store.filter.text = (e.target as HTMLInputElement).value
    refilter()
  })
  $<HTMLSelectElement>('#level').addEventListener('change', (e) => {
    store.filter.level = (e.target as HTMLSelectElement).value as typeof store.filter.level
    refilter()
  })
  $<HTMLSelectElement>('#proc').addEventListener('change', (e) => {
    store.filter.proc = (e.target as HTMLSelectElement).value || null
    refilter()
    onFacets()
  })
  $('#pause').addEventListener('click', () => {
    store.paused = !store.paused
    $('#pause').textContent = store.paused ? 'Resume' : 'Pause'
    $('#pause').setAttribute('aria-pressed', String(store.paused))
    updateCount()
  })
  $<HTMLInputElement>('#follow').addEventListener('change', (e) => {
    follow = (e.target as HTMLInputElement).checked
    if (follow) list.scrollToBottom()
  })

  $('#export').addEventListener('click', async () => {
    try {
      const text = await tiny.admin.kernel<string>('logExport', { includePrivate: $<HTMLInputElement>('#priv').checked })
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
      const path = await tiny.dialogs.saveFile({ name: `tiny-log-${stamp}.jsonl`, title: 'Export Log', startIn: '/Users/pear/Documents' })
      if (!path) return
      await tiny.writeFile(path, bytesOf(text ? `${text}\n` : ''))
      note(`Exported ${text ? text.split('\n').length : 0} messages to ${path}`)
    } catch (e) {
      await tiny.dialogs.alert({ message: 'The log could not be exported.', detail: errText(e) })
    }
  })
  $('#clear').addEventListener('click', async () => {
    if (!(await tiny.dialogs.confirm('Clear the system log?', { detail: 'All messages, including the saved log files, are deleted. This cannot be undone.', buttons: ['Clear', 'Cancel'], danger: true }))) return
    try {
      await tiny.admin.kernel('logClear')
      store.reset()
      pick(undefined)
      draw()
      onFacets()
      procOptions()
    } catch (e) {
      await tiny.dialogs.alert({ message: 'The log could not be cleared.', detail: errText(e) })
    }
  })

  let knownProcs = 0
  return {
    el: root,
    refilter() {
      $<HTMLInputElement>('#level').value = store.filter.level
      $<HTMLInputElement>('#q').value = store.filter.text
      procOptions()
      refilter()
    },
    search(text) {
      $<HTMLInputElement>('#q').value = text
      store.filter.text = text
      refilter()
    },
    show() {
      list.schedule()
    },
    async tick() {
      if (store.paused) return
      const n = await store.poll()
      if (!n) return
      draw()
      onFacets()
      if (store.procs.size !== knownProcs) {
        knownProcs = store.procs.size
        procOptions()
      }
    },
  }
}
