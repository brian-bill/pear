import { tiny } from '@tiny/sdk'
import { history } from './history'
import { drawSpark } from './spark'
import type { Sample, Tab } from './types'
import { duration, el, formatBytes, statGrid } from './util'

interface Storage { quota: number | null; usage: number | null; persisted: boolean }
interface Battery { level: number; charging: boolean }

export function memoryTab(): Tab {
  const root = el('div', 'panel')
  const pad = el('div', 'pad')
  root.append(pad)

  pad.insertAdjacentHTML('beforeend', `<h3>JavaScript heap</h3>
    <div class="card"><div class="chart-head"><span id="heaplabel"></span><span>Last 2 minutes</span></div><canvas class="spark" id="heapspark" aria-label="JavaScript heap over the last two minutes"></canvas></div>`)
  const heap = statGrid([['used', 'Heap used'], ['total', 'Heap allocated'], ['limit', 'Heap limit']])
  heap.el.style.marginTop = '10px'
  pad.append(heap.el)

  pad.insertAdjacentHTML('beforeend', '<h3>System</h3>')
  const sys = statGrid([['uptime', 'Uptime'], ['procs', 'Processes'], ['ports', 'Ports'], ['files', 'Open files'], ['battery', 'Battery'], ['thermal', 'Thermal / pressure']])
  pad.append(sys.el)

  pad.insertAdjacentHTML('beforeend', '<h3>Storage</h3>')
  const storage = el('div', 'card', '<div class="row"><b id="stuse"></b><span class="grow"></span><span class="dim" id="stpersist"></span></div><div class="gauge" role="progressbar" aria-label="Storage used"><i id="stbar" style="width:0"></i></div>')
  pad.append(storage)

  pad.insertAdjacentHTML('beforeend', '<h3>Journal and log</h3>')
  const jl = statGrid([['seq', 'Journal sequence'], ['jbytes', 'Journal size'], ['ibytes', 'Index size'], ['records', 'Records since mount'], ['checkpoints', 'Checkpoints'], ['logn', 'Log entries in memory'], ['logbytes', 'Log segment size'], ['logdrop', 'Log entries dropped'], ['logpersist', 'Log persisted'], ['crashes', 'Crash reports']])
  pad.append(jl.el)

  const $ = (sel: string) => pad.querySelector<HTMLElement>(sel)!
  const size = (n: number | undefined | null) => (typeof n === 'number' ? formatBytes(n) : '-')

  async function slow(): Promise<void> {
    const [st, bat, th] = await Promise.all([
      tiny.system.info('storage').catch(() => null) as Promise<Storage | null>,
      tiny.system.info('battery').catch(() => null) as Promise<Battery | null>,
      tiny.system.info('thermal').catch(() => null) as Promise<string | null>,
    ])
    if (st && st.quota) {
      const used = st.usage ?? 0
      $('#stuse').textContent = `${formatBytes(used)} used of ${formatBytes(st.quota)} (${((used / st.quota) * 100).toFixed(1)}%)`
      $('#stbar').style.width = `${Math.min(100, (used / st.quota) * 100)}%`
      $('#stpersist').textContent = st.persisted ? 'Persistent' : 'Not persistent: the browser may clear it'
    } else $('#stuse').textContent = 'The browser does not report storage'
    sys.set('battery', bat ? `${Math.round(bat.level * 100)}%${bat.charging ? ', charging' : ''}` : 'Not available')
    sys.set('thermal', th ?? 'Not reported')
  }

  return {
    id: 'memory',
    title: 'Memory',
    el: root,
    async update(s: Sample) {
      const m = s.snap.memory
      $('#heaplabel').textContent = m ? `${formatBytes(m.usedJSHeapSize)} of ${formatBytes(m.limit)}` : 'This browser does not report the JavaScript heap'
      heap.set('used', size(m?.usedJSHeapSize))
      heap.set('total', size(m?.totalJSHeapSize))
      heap.set('limit', size(m?.limit))
      drawSpark($('#heapspark') as HTMLCanvasElement, history.heap, m?.limit ? Math.max(m.totalJSHeapSize * 1.2, ...history.heap) : undefined)
      sys.set('uptime', duration(s.snap.uptime))
      sys.set('procs', String(s.snap.processes.length))
      sys.set('ports', String(s.snap.ports))
      sys.set('files', String(s.snap.openFiles))
      const j = s.snap.journal
      jl.set('seq', String(j?.seq ?? '-'))
      jl.set('jbytes', size(j?.journalBytes))
      jl.set('ibytes', size(j?.indexBytes))
      jl.set('records', String(j?.records ?? '-'))
      jl.set('checkpoints', String(j?.checkpoints ?? '-'))
      jl.set('logn', String(s.snap.log.entries))
      jl.set('logbytes', size(s.snap.log.bytes))
      jl.set('logdrop', String(s.snap.log.dropped))
      jl.set('logpersist', s.snap.log.persisted ? 'Yes' : 'No (memory only)')
      jl.set('crashes', String(s.snap.crashes))
      await slow()
    },
  }
}
