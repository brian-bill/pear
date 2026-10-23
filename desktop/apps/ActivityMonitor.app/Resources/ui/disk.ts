import { tiny } from '@tiny/sdk'
import type { Sample, Tab } from './types'
import { el, errText, esc, formatBytes } from './util'

interface Statfs { total: number | null; used: number; free: number | null }
interface FsInfo { recovery: Record<string, number | boolean>; journal: { seq: number; journalBytes: number; indexBytes: number; records: number; checkpoints: number } }

const RECOVERY_LABELS: Record<string, string> = {
  replayedRecords: 'Journal records replayed',
  discardedJournalBytes: 'Corrupt journal bytes dropped',
  orphanBlobsRemoved: 'Orphaned data blobs removed',
  unlinkedFilesFreed: 'Deleted-but-open files freed',
  upgradedIndex: 'Index upgraded from an older format',
}

export function diskTab(): Tab {
  const root = el('div', 'panel')
  const pad = el('div', 'pad')
  root.append(pad)
  return {
    id: 'disk',
    title: 'Disk',
    el: root,
    async update(_s: Sample) {
      try {
        const [fs, info] = await Promise.all([(tiny.statfs() as Promise<Statfs>), tiny.admin.kernel<FsInfo>('fsInfo')])
        const pct = fs.total ? Math.min(100, (fs.used / fs.total) * 100) : 0
        const j = info.journal
        const rec = Object.entries(info.recovery)
        const clean = rec.every(([, v]) => !v)
        pad.innerHTML = `
          <h3>Pear Disk</h3>
          <div class="card"><div class="row"><b>${formatBytes(fs.used)} used</b><span class="grow"></span><span class="dim">${fs.free !== null ? `${formatBytes(fs.free)} available` : 'Free space unknown'}${fs.total ? ` of ${formatBytes(fs.total)}` : ''}</span></div>
          <div class="gauge" role="progressbar" aria-label="Disk used" aria-valuenow="${pct.toFixed(0)}"><i style="width:${pct}%"></i></div></div>
          <h3>Journal</h3>
          <table class="plain-table" aria-label="Journal"><tbody>
            <tr><th>Sequence</th><td>${j.seq}</td></tr><tr><th>Journal size</th><td>${formatBytes(j.journalBytes)}</td></tr><tr><th>Index size</th><td>${formatBytes(j.indexBytes)}</td></tr>
            <tr><th>Records since mount</th><td>${j.records}</td></tr><tr><th>Checkpoints since mount</th><td>${j.checkpoints}</td></tr></tbody></table>
          <h3>Recovery at the last mount</h3>
          <div class="dim" style="margin-bottom:6px">${clean ? 'The last shutdown was clean: nothing had to be repaired.' : 'The last session ended unexpectedly; the file system repaired itself:'}</div>
          <table class="plain-table" aria-label="Recovery"><tbody>${rec.map(([k, v]) => `<tr><th>${esc(RECOVERY_LABELS[k] ?? k)}</th><td>${esc(String(v))}</td></tr>`).join('')}</tbody></table>`
      } catch (e) {
        pad.innerHTML = `<div class="empty">Disk information is not available: ${esc(errText(e))}</div>`
      }
    },
  }
}
