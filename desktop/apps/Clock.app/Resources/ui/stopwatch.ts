/// Stopwatch: a rAF-driven centisecond label with start/stop, laps and reset. The rAF loop only runs
/// while the stopwatch view is on and the document is visible; elapsed time still advances from the
/// monotonic clock, so hidden tabs and tab switches cost nothing and lose nothing.
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export interface Stopwatch {
  activate(): void
  deactivate(): void
  pause(): void
  resume(): void
}

export function createStopwatch(el: HTMLElement): Stopwatch {
  const display = $('sw-display')
  const lapBtn = $<HTMLButtonElement>('sw-lap')
  const resetBtn = $<HTMLButtonElement>('sw-reset')
  const lapsHost = $('laps')

  let running = false
  let elapsed = 0 // ms accumulated before the current run
  let startedAt = 0 // performance.now() when the current run began
  let raf = 0
  let active = false
  const laps: Array<{ n: number; split: number; total: number }> = []

  const two = (n: number) => String(n).padStart(2, '0')

  /** `MM:SS.cc` (centiseconds), with hours making room past one hour. */
  function fmt(ms: number): string {
    const cs = Math.floor(Math.max(0, ms) / 10)
    const secs = Math.floor(cs / 100)
    const h = Math.floor(secs / 3600)
    const m = Math.floor((secs % 3600) / 60)
    const s = secs % 60
    const stack = h > 0 ? `${h}:${two(m)}:${two(s)}` : `${two(m)}:${two(s)}`
    return `${stack}.${two(cs % 100)}`
  }

  const current = (): number => (running ? performance.now() - startedAt : elapsed)

  function draw(): void {
    display.textContent = fmt(current())
  }

  function frame(): void {
    if (!running || !active || document.hidden) return
    draw()
    raf = requestAnimationFrame(frame)
  }

  const kick = () => {
    cancelAnimationFrame(raf)
    frame()
  }

  function renderButtons(): void {
    $('sw-start').textContent = running ? 'Stop' : 'Start'
    lapBtn.disabled = !running
    resetBtn.disabled = running || (elapsed === 0 && laps.length === 0)
  }

  function toggle(): void {
    if (running) {
      elapsed = performance.now() - startedAt
      running = false
      cancelAnimationFrame(raf)
      draw()
    } else {
      startedAt = performance.now() - elapsed
      running = true
      kick() // start drawing now; the tab is already active
    }
    renderButtons()
  }

  function lap(): void {
    if (!running) return
    const total = current()
    const split = total - (laps[laps.length - 1]?.total ?? 0)
    laps.push({ n: laps.length + 1, split, total })
    renderLaps()
  }

  function renderLaps(): void {
    lapsHost.replaceChildren(
      ...[...laps].reverse().map((l) => {
        const row = document.createElement('div')
        row.className = 'lap'
        const n = document.createElement('span')
        n.className = 'num'
        n.textContent = `Lap ${l.n}`
        const split = document.createElement('span')
        split.textContent = fmt(l.split)
        const totalEl = document.createElement('span')
        totalEl.className = 'total'
        totalEl.textContent = fmt(l.total)
        row.append(n, split, totalEl)
        return row
      }),
    )
  }

  function reset(): void {
    if (running) return
    elapsed = 0
    laps.length = 0
    renderLaps()
    draw()
    renderButtons()
  }

  $('sw-start').addEventListener('click', toggle)
  lapBtn.addEventListener('click', lap)
  resetBtn.addEventListener('click', reset)
  draw()
  renderButtons()

  return {
    activate: () => {
      active = true
      draw()
      kick()
    },
    deactivate: () => {
      active = false
      cancelAnimationFrame(raf)
    },
    pause: () => cancelAnimationFrame(raf),
    resume: () => {
      if (running && active) kick()
    },
  }
}
