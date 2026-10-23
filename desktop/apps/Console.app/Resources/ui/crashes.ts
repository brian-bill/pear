import { tiny } from '@tiny/sdk'
import type { CrashReport, CrashSummary, Pane } from './types'
import { clock, dateTime, el, errText, esc } from './util'

export interface CrashPane extends Pane {
  count(): number
  /** Reload the list (also called by the sidebar badge poll). */
  load(): Promise<void>
}

export function crashPane(onCount: (n: number) => void): CrashPane {
  const root = el('div', 'pane')
  root.innerHTML = `
    <div class="toolbar">
      <button id="share" disabled>Share Report</button>
      <button id="delall" class="danger" disabled>Delete All...</button>
      <span class="spacer"></span>
      <span class="dim" id="msg" role="status"></span>
    </div>
    <p class="explain dim">Pear writes a crash report when a program stops unexpectedly. Reports stay in this browser: nothing is sent anywhere. "Share Report" only marks a report as shared; to send one to someone, export the log or copy the text below.</p>
    <div class="crashsplit">
      <div class="crashlist scroll"><table class="list" aria-label="Crash reports"><thead><tr><th style="width:90px">Time</th><th>Process</th><th>App</th><th>Reason</th><th style="width:64px">Shared</th></tr></thead><tbody></tbody></table></div>
      <div class="crashdetail scroll selectable" aria-label="Crash report"><div class="empty">Select a crash report.</div></div>
    </div>`
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  let reports: CrashSummary[] = []
  let selected: string | null = null
  const msg = (t: string) => ($('#msg').textContent = t)

  const reason = (c: CrashSummary) => c.signal ?? c.error ?? (c.code !== null ? `exit ${c.code}` : '')

  function renderList(): void {
    $('tbody').innerHTML = reports.length
      ? [...reports].reverse().map((c) => `<tr data-id="${esc(c.id)}" class="${c.id === selected ? 'selected' : ''}"><td>${clock(c.time, false)}</td><td>${esc(c.name)}</td><td>${esc(c.appId ?? '-')}</td><td title="${esc(reason(c))}">${esc(reason(c))}</td><td>${c.submitted ? 'Yes' : 'No'}</td></tr>`).join('')
      : '<tr><td colspan="5" class="empty">No crash reports. Good news.</td></tr>'
    $<HTMLButtonElement>('#delall').disabled = !reports.length
    $<HTMLButtonElement>('#share').disabled = !selected
  }

  async function open(id: string | null): Promise<void> {
    selected = id
    renderList()
    const box = $('.crashdetail')
    if (!id) return void (box.innerHTML = '<div class="empty">Select a crash report.</div>')
    try {
      const r = await tiny.admin.kernel<CrashReport>('crashGet', id)
      if (selected !== id) return
      box.innerHTML = `<h3>${esc(r.name)} quit unexpectedly</h3>
        <dl><dt>Time</dt><dd>${esc(dateTime(r.time))}</dd><dt>Process</dt><dd>pid ${r.pid}${r.appId ? `, ${esc(r.appId)}` : ''}</dd><dt>Exit</dt><dd>${r.signal ? `signal ${esc(r.signal)}` : `code ${r.code ?? '-'}`}</dd><dt>Version</dt><dd>${esc(r.version)}</dd><dt>Shared</dt><dd>${r.submitted ? 'Yes' : 'No'}</dd></dl>
        <div class="label">Error</div><pre>${esc(r.error ?? '(none)')}</pre>
        <div class="label">Standard error</div><pre>${esc(r.stderr || '(empty)')}</pre>
        <div class="label">Recent log lines</div><pre>${r.recent.length ? esc(r.recent.map((e) => `${clock(e.time)} ${e.level.padEnd(6)} ${e.subsystem}: ${e.message}`).join('\n')) : '(none)'}</pre>`
    } catch (e) {
      box.innerHTML = `<div class="empty">${esc(errText(e))}</div>`
    }
  }

  $('tbody').addEventListener('click', (e) => {
    const tr = (e.target as HTMLElement).closest<HTMLElement>('tr[data-id]')
    if (tr) void open(tr.dataset.id!)
  })

  $('#share').addEventListener('click', async () => {
    if (!selected) return
    try {
      await tiny.admin.kernel('crashSubmit', selected)
      msg('Marked as shared. Nothing was sent.')
      await load()
      await open(selected)
    } catch (e) {
      msg(errText(e))
    }
  })
  $('#delall').addEventListener('click', async () => {
    if (!(await tiny.dialogs.confirm('Delete all crash reports?', { detail: 'The reports are removed from this browser. This cannot be undone.', buttons: ['Delete All', 'Cancel'], danger: true }))) return
    try {
      await tiny.admin.kernel('crashClear')
      await load()
      await open(null)
    } catch (e) {
      msg(errText(e))
    }
  })

  async function load(): Promise<void> {
    try {
      reports = await tiny.admin.kernel<CrashSummary[]>('crashList')
    } catch (e) {
      msg(errText(e))
      return
    }
    if (selected && !reports.some((r) => r.id === selected)) {
      selected = null
      $('.crashdetail').innerHTML = '<div class="empty">Select a crash report.</div>'
    }
    onCount(reports.length)
    renderList()
  }

  return { el: root, count: () => reports.length, load, show: () => void load(), tick: load }
}
