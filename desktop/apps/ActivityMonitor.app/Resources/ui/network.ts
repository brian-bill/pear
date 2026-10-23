import { tiny } from '@tiny/sdk'
import type { Sample, Tab } from './types'
import { el, errText, esc, formatBytes } from './util'

interface Usage { bytesIn: number; bytesOut: number; requests: number }

export function networkTab(): Tab {
  const root = el('div', 'panel')
  root.innerHTML = `<div class="toolbar bar top"><span class="dim">Network use per app since the system started</span><span class="spacer"></span><button id="reset">Reset Counters</button></div><div class="pad"></div>`
  const pad = root.querySelector<HTMLElement>('.pad')!
  const reset = root.querySelector<HTMLButtonElement>('#reset')!
  let busy = false
  reset.addEventListener('click', async () => {
    if (!(await tiny.dialogs.confirm('Reset the network counters?', { buttons: ['Reset', 'Cancel'] }))) return
    busy = true
    try {
      await tiny.admin.service('tiny.network', { op: 'usage.reset' })
    } finally {
      busy = false
    }
    pad.innerHTML = ''
  })
  return {
    id: 'network',
    title: 'Network',
    el: root,
    async update(s: Sample) {
      if (busy) return
      try {
        const usage = await tiny.admin.service<Record<string, Usage> | Usage>('tiny.network', { op: 'usage' })
        const rows = Object.entries(usage as Record<string, Usage>).filter(([, u]) => typeof u === 'object')
        rows.sort((a, b) => b[1].bytesIn + b[1].bytesOut - (a[1].bytesIn + a[1].bytesOut))
        const label = (k: string) => (k.startsWith('pid:') ? `Process ${k.slice(4)}` : (s.appNames.get(k) ?? k))
        const tot = rows.reduce((t, [, u]) => ({ bytesIn: t.bytesIn + u.bytesIn, bytesOut: t.bytesOut + u.bytesOut, requests: t.requests + u.requests }), { bytesIn: 0, bytesOut: 0, requests: 0 })
        pad.innerHTML = rows.length
          ? `<table class="plain-table" aria-label="Network usage"><thead><tr><th>App</th><th>Received</th><th>Sent</th><th>Requests</th></tr></thead><tbody>${rows
              .map(([k, u]) => `<tr><td>${esc(label(k))}</td><td>${formatBytes(u.bytesIn)}</td><td>${formatBytes(u.bytesOut)}</td><td>${u.requests}</td></tr>`)
              .join('')}</tbody><tfoot><tr><td><b>Total</b></td><td><b>${formatBytes(tot.bytesIn)}</b></td><td><b>${formatBytes(tot.bytesOut)}</b></td><td><b>${tot.requests}</b></td></tr></tfoot></table>`
          : '<div class="empty">No app has used the network yet.</div>'
      } catch (e) {
        pad.innerHTML = `<div class="empty">Network usage is not available: ${esc(errText(e))}</div>`
      }
    },
  }
}
