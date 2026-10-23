/** A small line chart on a canvas, in the accent colour, filled underneath. `max` fixes the top of the scale. */
export function drawSpark(canvas: HTMLCanvasElement, values: number[], max?: number): void {
  const dpr = window.devicePixelRatio || 1
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (!w || !h) return
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const g = canvas.getContext('2d')!
  g.scale(dpr, dpr)
  g.clearRect(0, 0, w, h)
  const css = getComputedStyle(canvas)
  const accent = css.getPropertyValue('--accent').trim() || '#0a84ff'
  g.strokeStyle = 'rgba(127,127,127,0.25)'
  g.lineWidth = 1
  g.beginPath()
  g.moveTo(0, h - 0.5)
  g.lineTo(w, h - 0.5)
  g.stroke()
  if (values.length < 2) return
  const top = max ?? Math.max(1, ...values) * 1.15
  const step = w / (WINDOW_POINTS - 1)
  const x = (i: number) => w - (values.length - 1 - i) * step
  const y = (v: number) => h - 2 - (v / top) * (h - 6)
  g.beginPath()
  values.forEach((v, i) => (i ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v))))
  g.strokeStyle = accent
  g.lineWidth = 1.5
  g.lineJoin = 'round'
  g.stroke()
  g.lineTo(x(values.length - 1), h)
  g.lineTo(x(0), h)
  g.closePath()
  g.globalAlpha = 0.18
  g.fillStyle = accent
  g.fill()
}

/** Samples kept: two minutes at one every two seconds. */
export const WINDOW_POINTS = 60
