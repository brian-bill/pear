import { tiny } from '@tiny/sdk'
import { Screen } from './screen'

const KEYS: Record<string, string> = {
  Enter: '\r', Backspace: '\x7f', Tab: '\t', Escape: '\x1b', ArrowUp: '\x1b[A', ArrowDown: '\x1b[B', ArrowRight: '\x1b[C', ArrowLeft: '\x1b[D', Delete: '\x1b[3~',
}
const view = document.getElementById('term')!
const screen = new Screen()
const dec = new TextDecoder()
const enc = new TextEncoder()
let master = -1
let pid = -1
let frame = 0
let closed = false

function draw(): void {
  frame = 0
  const before = screen.lines.slice(0, screen.row).join('\n')
  const cur = screen.lines[screen.row]!
  const at = cur.padEnd(screen.col + 1, ' ')
  const after = screen.lines.slice(screen.row + 1).join('\n')
  view.replaceChildren(
    document.createTextNode(`${before}${screen.row ? '\n' : ''}${at.slice(0, screen.col)}`),
    Object.assign(document.createElement('span'), { className: 'cursor', textContent: at[screen.col] ?? ' ' }),
    document.createTextNode(`${at.slice(screen.col + 1)}${after ? `\n${after}` : ''}`),
  )
  view.scrollTop = view.scrollHeight
}
const redraw = () => (frame ||= requestAnimationFrame(draw))

function size(): { cols: number; rows: number } {
  const probe = Object.assign(document.createElement('span'), { textContent: 'M'.repeat(20) })
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:pre'
  view.append(probe)
  const cw = probe.getBoundingClientRect().width / 20 || 7
  const ch = parseFloat(getComputedStyle(view).lineHeight) || 16
  probe.remove()
  return { cols: Math.max(20, Math.floor((view.clientWidth - 16) / cw)), rows: Math.max(5, Math.floor((view.clientHeight - 12) / ch)) }
}

async function start(): Promise<void> {
  await tiny.ready
  void tiny.window.setMenus([
    { title: 'Terminal', items: [{ label: 'New Window', shortcut: 'Cmd+N', action: () => void tiny.app.openWindow() }] },
    { title: 'Edit', items: [{ label: 'Clear Screen', shortcut: 'Cmd+K', action: () => send('\x0c') }] },
  ])
  try {
    // a terminal pair, and a shell on it as session leader: what a terminal emulator does
    const pty = await tiny.openpty()
    master = pty.master
    await tiny.setwinsize(master, size())
    pid = await tiny.spawn('/bin/sh', {
      cwd: '/Users/pear',
      env: { PS1: 'pear@pear ~ % ', HOME: '/Users/pear', USER: 'pear', TERM: 'dumb' },
      setsid: true,
      stdio: { stdin: { fd: pty.slave }, stdout: { fd: pty.slave }, stderr: { fd: pty.slave } },
    })
    await tiny.close(pty.slave)
    for (;;) {
      const chunk = await tiny.read(master, 65536)
      if (!chunk || !chunk.length) break
      screen.write(dec.decode(chunk, { stream: true }))
      redraw()
    }
  } catch (e) {
    if (!closed) screen.write(`\r\nTerminal: ${(e as Error).message}\r\n`)
  }
  if (!closed) {
    screen.write('\r\n[Process completed]\r\n')
    redraw()
    master = -1
    tiny.window.setTitle('Terminal — finished')
  }
}

function send(data: string): void {
  if (master >= 0) void tiny.write(master, enc.encode(data)).catch(() => {})
}

view.addEventListener('keydown', (e) => {
  if ((e.metaKey && !e.ctrlKey) || (e.altKey && e.key === 'Tab')) return // Desktop and menu shortcuts
  let data = KEYS[e.key]
  if (!data && e.ctrlKey && /^[a-z]$/i.test(e.key)) data = String.fromCharCode(e.key.toUpperCase().charCodeAt(0) - 64)
  if (!data && e.key.length === 1 && !e.ctrlKey && !e.altKey) data = e.key
  if (data === undefined) return
  e.preventDefault()
  send(data)
})
view.addEventListener('paste', (e) => {
  e.preventDefault()
  send((e.clipboardData?.getData('text/plain') ?? '').replace(/\r?\n/g, '\r'))
})
document.body.addEventListener('pointerdown', () => queueMicrotask(() => view.focus()))
new ResizeObserver(() => {
  if (master >= 0) void tiny.setwinsize(master, size()).catch(() => {})
}).observe(view)
tiny.on('focus', () => view.focus())
tiny.window.onCloseRequest(() => {
  closed = true
  if (master >= 0) void tiny.close(master).catch(() => {})
  if (pid > 0) void tiny.kill(pid, 'SIGHUP').catch(() => {})
})
view.focus()
void start()
