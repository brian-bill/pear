/// Countdown timer: h/m/s inputs, one big MM:SS label ticking per second, cancel while it runs, a
/// notification at zero (fire-and-forget through `tiny.notifications`). The remaining time is computed
/// from a monotonic endpoint, so hidden-tab throttling never skews it; the tick interval pauses when the
/// document is hidden and catches up on resume.
import { tiny } from '@tiny/sdk'

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

export interface TimerSave {
  duration: { h: number; m: number; s: number }
}

export interface Countdown {
  /** The primary action: start from idle, reset when it has finished. Does nothing while running. */
  advance(): void
  pause(): void
  resume(): void
  snapshot(): TimerSave
}

export function createCountdown(el: HTMLElement, save?: TimerSave): Countdown {
  const inputs = { h: $<HTMLInputElement>('t-h'), m: $<HTMLInputElement>('t-m'), s: $<HTMLInputElement>('t-s') }
  const display = $('timer-display')
  const action = $('timer-action')
  const hint = el.querySelector<HTMLElement>('.hint')

  type State = 'idle' | 'running' | 'finished'
  let state: State = 'idle'
  let dur: { h: number; m: number; s: number } = save?.duration ?? { h: 0, m: 0, s: 0 }
  let endAt = 0 // performance.now() when it hits zero
  let remaining = 0 // whole seconds left the label currently shows
  let handle: ReturnType<typeof setInterval> | undefined

  const two = (n: number) => String(n).padStart(2, '0')

  const read = (input: HTMLInputElement, max: number): number => {
    const n = Math.floor(Number(input.value))
    if (!Number.isFinite(n)) return 0
    return Math.max(0, Math.min(n, max))
  }

  const total = (d: { h: number; m: number; s: number } = dur): number => d.h * 3600 + d.m * 60 + d.s

  function fmt(totalSec: number): string {
    const s = Math.max(0, Math.floor(totalSec))
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${two(m)}:${two(s % 60)}`
  }

  function setLabel(seconds: number): void {
    remaining = Math.max(0, seconds)
    display.textContent = fmt(remaining)
  }

  function render(): void {
    const idle = state === 'idle'
    $('timer-inputs').classList.toggle('off', state === 'running')
    action.textContent = state === 'running' ? 'Cancel' : state === 'finished' ? 'Reset' : 'Start'
    action.classList.toggle('primary', state !== 'finished')
    action.classList.toggle('danger', state === 'finished')
    hint?.toggleAttribute('hidden', !idle)
    if (idle) setLabel(total())
    if (state === 'running') setLabel(Math.ceil((endAt - performance.now()) / 1000))
  }

  function tick(): void {
    if (state !== 'running') return
    const left = Math.ceil((endAt - performance.now()) / 1000)
    if (left <= 0) return finish()
    if (left !== remaining) setLabel(left)
  }

  function start(): void {
    if (state !== 'idle') return
    const d = { h: read(inputs.h, 23), m: read(inputs.m, 59), s: read(inputs.s, 59) }
    dur = d
    if (total(d) < 1) return
    endAt = performance.now() + total(d) * 1000
    state = 'running'
    render()
    startInterval()
  }

  function startInterval(): void {
    clearInterval(handle)
    handle = setInterval(tick, 250)
  }

  function stopInterval(): void {
    clearInterval(handle)
    handle = undefined
  }

  /** Zero reached (or found so on resume): tell the user, then land on the reset state. */
  function finish(): void {
    stopInterval()
    state = 'finished'
    setLabel(0)
    render()
    void tiny.service('tiny.notifications', { op: 'post', title: 'Timer', body: 'Done' }).catch(() => {
      // notifications are best-effort; the UI state is already correct without them
    })
  }

  function stop(): void {
    stopInterval()
    state = 'idle'
    render()
  }

  function reset(): void {
    state = 'idle'
    for (const [k, v] of Object.entries(dur)) inputs[k as 'h' | 'm' | 's'].value = String(v)
    render()
  }

  function advance(): void {
    if (state === 'idle') start()
    else if (state === 'finished') reset()
  }

  action.addEventListener('click', advance)
  const onInput = () => {
    if (state !== 'idle') return
    dur = { h: read(inputs.h, 23), m: read(inputs.m, 59), s: read(inputs.s, 59) }
    setLabel(total())
  }
  for (const i of Object.values(inputs)) {
    i.addEventListener('input', onInput)
    i.addEventListener('change', () => {
      // clamp what the user typed (75 seconds -> 59) without fighting the keystroke
      if (state === 'idle') {
        i.value = String(read(i, Number(i.max)))
        onInput()
      }
    })
  }

  for (const [k, v] of Object.entries(dur)) inputs[k as 'h' | 'm' | 's'].value = String(v)
  render()

  return {
    advance,
    pause: stopInterval,
    resume: () => {
      if (state === 'running') {
        tick()
        startInterval()
      }
    },
    snapshot: () => ({ duration: { ...dur } }),
  }
}
