import { escapeHtml, tiny } from '@tiny/sdk'

const bytes = (n: number | null) => (n === null ? '—' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`)
const uptime = (ms: number) => {
  const m = Math.floor(ms / 60000)
  return m < 1 ? 'less than a minute' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`
}

async function main(): Promise<void> {
  await tiny.ready
  const dl = document.getElementById('rows')!
  try {
    const s = await tiny.system.info('snapshot')
    const rows: Array<[string, string]> = [
      ['Version', `${s.version.version} (${s.version.build})`],
      ['Kernel', s.version.kernel],
      ['Computer', s.hostname],
      ['Processor', `${s.hardware.cores ?? '—'} cores`],
      ['Memory', s.hardware.memoryHint ? `${s.hardware.memoryHint} GB` : '—'],
      ['Storage', `${bytes(s.storage.usage)} of ${bytes(s.storage.quota)}${s.storage.persisted ? '' : ' '}`],
      ['Uptime', uptime(s.uptime)],
      ['Language', s.locale.tag],
    ]
    dl.innerHTML = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('')
  } catch (e) {
    dl.textContent = `System information is not available: ${(e as Error).message}`
  }
}
void main()
