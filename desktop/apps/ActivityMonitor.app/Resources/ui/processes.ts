import { tiny } from '@tiny/sdk'
import { history } from './history'
import { drawSpark } from './spark'
import type { ProcessInfo, Sample, Tab } from './types'
import { appLabel, duration, el, errText, esc, userName } from './util'

interface Column {
  key: string
  label: string
  width?: string
  num?: boolean
  value(p: ProcessInfo, s: Sample): string | number
  /** CSS class for the cell. */
  cls?(p: ProcessInfo): string
}

const COLUMNS: Column[] = [
  { key: 'pid', label: 'PID', width: '56px', num: true, value: (p) => p.pid },
  { key: 'name', label: 'Process Name', value: (p) => p.name },
  { key: 'app', label: 'App / Bundle', value: (p, s) => appLabel(s, p.appId ?? p.bundleId) },
  { key: 'user', label: 'User', width: '64px', value: (p) => userName(p.uid) },
  { key: 'state', label: 'State', width: '72px', value: (p) => p.state },
  { key: 'files', label: 'Files', width: '56px', num: true, value: (p) => p.openFds },
  { key: 'uptime', label: 'Uptime', width: '84px', num: true, value: (p, s) => (p.exitedAt ?? s.now) - p.startedAt },
  { key: 'responding', label: 'Responding', width: '88px', value: (p) => (p.unresponsive ? 'No' : 'Yes'), cls: (p) => (p.unresponsive ? 'bad' : '') },
  { key: 'kind', label: 'Kind', width: '72px', value: (p) => p.kind ?? '-' },
]

const show = (c: Column, p: ProcessInfo, s: Sample) => (c.key === 'uptime' ? duration(c.value(p, s) as number) : String(c.value(p, s)))

export function processesTab(): Tab & { onRefresh(fn: () => void): void } {
  const root = el('div', 'panel')
  root.innerHTML = `
    <div class="toolbar bar top">
      <button data-act="quit" disabled title="Ask the process to quit (SIGTERM)">Quit</button>
      <button data-act="force" class="danger" disabled title="End the process immediately (SIGKILL)">Force Quit</button>
      <button data-act="inspect" disabled aria-pressed="false">Inspect</button>
      <span class="spacer"></span>
      <input type="search" id="search" placeholder="Filter" aria-label="Filter processes">
    </div>
    <div class="scroll"><table class="list proc-table" aria-label="Processes"><colgroup></colgroup><thead></thead><tbody></tbody></table></div>
    <div class="inspect bar" hidden aria-label="Process details"></div>
    <div class="status bar"><span id="count"></span><span class="grow"></span><span class="dim">Processes, last 2 min</span><canvas class="spark" id="procspark" style="width:160px;height:28px" aria-label="Process count over the last two minutes"></canvas></div>`
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!
  const tbody = $('tbody')
  const inspect = $('.inspect')
  const search = $<HTMLInputElement>('#search')
  const btn = (act: string) => $<HTMLButtonElement>(`[data-act=${act}]`)

  let sort = { key: 'pid', dir: 1 }
  let selected: number | null = null
  let inspecting = false
  let last: Sample | null = null

  $('colgroup').innerHTML = COLUMNS.map((c) => `<col${c.width ? ` style="width:${c.width}"` : ''}>`).join('')
  const head = () => {
    $('thead').innerHTML = `<tr>${COLUMNS.map((c) => `<th class="${c.num ? 'num' : ''}" data-key="${c.key}" role="columnheader" tabindex="0" ${c.key === sort.key ? `aria-sort="${sort.dir > 0 ? 'ascending' : 'descending'}"` : ''}>${esc(c.label)}${c.key === sort.key ? `<span class="arrow">${sort.dir > 0 ? '▲' : '▼'}</span>` : ''}</th>`).join('')}</tr>`
  }
  head()

  const visible = (s: Sample): ProcessInfo[] => {
    const q = search.value.trim().toLowerCase()
    const col = COLUMNS.find((c) => c.key === sort.key)!
    const rows = s.procs.filter((p) => !q || COLUMNS.some((c) => String(c.value(p, s)).toLowerCase().includes(q)) || p.path.toLowerCase().includes(q))
    return rows.sort((a, b) => {
      const x = col.value(a, s)
      const y = col.value(b, s)
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * sort.dir || a.pid - b.pid
    })
  }

  function render(s: Sample): void {
    const rows = visible(s)
    tbody.innerHTML = rows
      .map(
        (p) =>
          `<tr data-pid="${p.pid}" role="row" aria-selected="${p.pid === selected}" class="${p.pid === selected ? 'selected' : ''} ${p.state}">${COLUMNS.map((c) => `<td class="${c.num ? 'num' : ''} ${c.cls?.(p) ?? ''}" title="${esc(show(c, p, s))}">${esc(show(c, p, s))}</td>`).join('')}</tr>`,
      )
      .join('')
    const bad = s.procs.filter((p) => p.unresponsive).length
    $('#count').textContent = `${s.procs.length} processes${rows.length !== s.procs.length ? `, ${rows.length} shown` : ''}${bad ? `, ${bad} not responding` : ''}`
    if (selected !== null && !s.procs.some((p) => p.pid === selected)) select(null)
    drawSpark($<HTMLCanvasElement>('#procspark'), history.procs)
  }

  function select(pid: number | null): void {
    selected = pid
    for (const r of tbody.querySelectorAll('tr')) {
      const on = Number((r as HTMLElement).dataset.pid) === pid
      r.classList.toggle('selected', on)
      r.setAttribute('aria-selected', String(on))
    }
    btn('quit').disabled = btn('force').disabled = pid === null || pid === 1
    btn('inspect').disabled = pid === null
    void showInspect()
  }

  async function showInspect(): Promise<void> {
    inspect.hidden = !(inspecting && selected !== null)
    if (inspect.hidden) return
    const pid = selected!
    try {
      const i = await tiny.admin.kernel<ProcessInfo>('processInfo', pid)
      if (pid !== selected) return
      const when = (t: number | null) => (t ? new Date(t).toLocaleTimeString() : '-')
      const rows: Array<[string, string]> = [
        ['Process', `${i.name} (pid ${i.pid}, parent ${i.ppid})`],
        ['Path', i.path],
        ['Arguments', i.args.length ? i.args.map((a) => JSON.stringify(a)).join(' ') : '(none)'],
        ['Working directory', i.cwd],
        ['Group / session', `${i.pgid} / ${i.sid}`],
        ['User / group', `${userName(i.uid)} (${i.uid}) / ${i.gid}`],
        ['Bundle', `${i.bundleId ?? '-'}${i.kind ? ` (${i.kind})` : ''}`],
        ['App confinement', i.appId ?? 'none'],
        ['Open files', String(i.openFds)],
        ['Started', when(i.startedAt)],
        ['Exit status', i.status ? JSON.stringify(i.status) : i.state === 'zombie' ? 'exited' : 'running'],
      ]
      inspect.innerHTML = `<dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl><div class="row" style="margin-top:6px"><button data-act="ping">Ping</button><span class="dim" id="pingout"></span></div>`
    } catch (e) {
      inspect.textContent = `Process ${pid}: ${errText(e)}`
    }
  }

  async function ping(): Promise<void> {
    const out = inspect.querySelector('#pingout')
    if (selected === null || !out) return
    out.textContent = 'Pinging...'
    try {
      out.textContent = `Replied in ${await tiny.admin.kernel<number>('ping', selected, 2000)} ms`
    } catch (e) {
      out.textContent = `No answer: ${errText(e)}`
    }
  }

  async function end(force: boolean): Promise<void> {
    const p = last?.procs.find((x) => x.pid === selected)
    if (!p) return
    const ok = await tiny.dialogs.confirm(force ? `Force quit "${p.name}"?` : `Quit "${p.name}"?`, {
      detail: force ? 'The process is ended immediately. Unsaved work in it is lost.' : 'The process is asked to quit (SIGTERM) and may save its work first.',
      buttons: [force ? 'Force Quit' : 'Quit', 'Cancel'],
      danger: force,
    })
    if (!ok) return
    try {
      await tiny.admin.kernel('kill', p.pid, force ? 'SIGKILL' : 'SIGTERM')
    } catch (e) {
      await tiny.dialogs.alert({ message: `Could not end ${p.name}.`, detail: errText(e) })
    }
    refreshSoon()
  }

  let refreshSoon: () => void = () => {}

  // pointerdown, not click: the table is rebuilt every two seconds and a click can straddle a rebuild
  tbody.addEventListener('pointerdown', (e) => {
    const tr = (e.target as HTMLElement).closest('tr')
    if (tr) select(Number(tr.dataset.pid))
  })
  const sortBy = (key: string) => {
    sort = { key, dir: sort.key === key ? -sort.dir : 1 }
    head()
    if (last) render(last)
  }
  $('thead').addEventListener('click', (e) => {
    const th = (e.target as HTMLElement).closest('th')
    if (th) sortBy(th.dataset.key!)
  })
  $('thead').addEventListener('keydown', (e) => {
    const th = (e.target as HTMLElement).closest('th')
    if (th && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault()
      sortBy(th.dataset.key!)
    }
  })
  search.addEventListener('input', () => last && render(last))
  btn('quit').addEventListener('click', () => void end(false))
  btn('force').addEventListener('click', () => void end(true))
  btn('inspect').addEventListener('click', () => {
    inspecting = !inspecting
    btn('inspect').setAttribute('aria-pressed', String(inspecting))
    btn('inspect').classList.toggle('on', inspecting)
    void showInspect()
  })
  inspect.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).dataset.act === 'ping') void ping()
  })

  const tab: Tab & { onRefresh(fn: () => void): void } = {
    id: 'processes',
    title: 'Processes',
    el: root,
    update(s) {
      last = s
      render(s)
      if (inspecting) void showInspect()
    },
    onRefresh(fn) {
      refreshSoon = fn
    },
  }
  return tab
}
