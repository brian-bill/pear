import { tiny } from '@tiny/sdk'
import type { AuditEntry, Pane } from './types'
import { clock, el, errText, esc } from './util'

/** The permission audit: grants, denials, prompts and refused file calls. */
export function auditPane(): Pane {
  const root = el('div', 'pane')
  root.innerHTML = `
    <div class="toolbar"><input type="search" id="aq" class="grow" placeholder="Filter audit entries" aria-label="Filter audit entries"><button id="arefresh">Refresh</button></div>
    <div class="scroll"><table class="list" aria-label="Permission audit"><thead><tr><th style="width:90px">Time</th><th style="width:90px">Event</th><th style="width:180px">App</th><th>What</th></tr></thead><tbody></tbody></table></div>
    <div class="status"><span id="acount"></span></div>`
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!
  let entries: AuditEntry[] = []

  function render(): void {
    const q = $<HTMLInputElement>('#aq').value.trim().toLowerCase()
    const what = (a: AuditEntry) => [a.capability, a.call, a.path, a.detail].filter(Boolean).join('  ')
    const rows = [...entries].reverse().filter((a) => !q || `${a.event} ${a.appId} ${what(a)}`.toLowerCase().includes(q))
    $('tbody').innerHTML = rows.map((a) => `<tr><td>${clock(a.time, false)}</td><td class="ev-${a.event}">${esc(a.event)}</td><td>${esc(a.appId ?? 'system')}</td><td title="${esc(what(a))}">${esc(what(a))}</td></tr>`).join('') || '<tr><td colspan="4" class="empty">No audit entries.</td></tr>'
    $('#acount').textContent = `${rows.length} of ${entries.length} entries`
  }
  async function load(): Promise<void> {
    try {
      entries = await tiny.admin.kernel<AuditEntry[]>('permAudit', 1000)
      render()
    } catch (e) {
      $('#acount').textContent = errText(e)
    }
  }
  $('#aq').addEventListener('input', render)
  $('#arefresh').addEventListener('click', () => void load())
  return { el: root, show: () => void load(), tick: load }
}
