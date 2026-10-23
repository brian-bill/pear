import { inject } from '@vercel/analytics'
import { createKernel } from '../../vanilla/kernel/src/client'
import { attachDrivers } from '../../vanilla/kernel/src/drivers-page'
import { guardTabs } from '../../vanilla/kernel/src/tab-lock'
import './themes/desktop.css'
import { Desktop } from './desktop'

// Vercel Web Analytics: one page view per visit to the desktop.
inject()

declare global {
  interface Window {
    /** For tests and the console: the running desktop. */
    tiny?: Desktop
  }
}

const params = new URLSearchParams(location.search)
/** Which file system this tab uses. `?ns=` gives tests and experiments a private one. */
const namespace = params.get('ns') ?? 'tiny'
const bootEl = document.getElementById('boot')!
const fill = bootEl.querySelector<HTMLElement>('.boot-fill')!
const stage = bootEl.querySelector<HTMLElement>('.boot-stage')!
const root = document.getElementById('desktop')!
/** Set when the page is going away in an orderly manner (tab closed or reloaded); a crash or power cut never gets to. */
const EXIT_KEY = `tiny:${namespace}:exit`
const exitedCleanly = () => {
  try {
    const was = localStorage.getItem(EXIT_KEY) === 'clean'
    localStorage.removeItem(EXIT_KEY)
    return was
  } catch {
    return false
  }
}
window.addEventListener('pagehide', () => {
  try {
    localStorage.setItem(EXIT_KEY, 'clean')
  } catch {
    // storage blocked: the next start looks like a crash
  }
})
/** The running system, so a takeover by another tab can stop it. */
let running: { shutdown(): Promise<void> } | null = null

const progress = (text: string, fraction: number) => {
  fill.style.width = `${Math.round(fraction * 100)}%`
  stage.textContent = text
}

/** A full-screen message with one button (second tab, powered off, crash recovery). */
function notice(title: string, text: string, buttons: Array<{ label: string; run: () => void }>): HTMLElement {
  const el = document.createElement('div')
  el.id = 'notice'
  el.setAttribute('role', 'alertdialog')
  el.setAttribute('aria-label', title)
  el.style.cssText = 'position:fixed;inset:0;z-index:10000;display:grid;place-content:center;justify-items:center;gap:14px;background:rgba(0,0,0,.82);color:#fff;text-align:center;font:14px var(--font,system-ui)'
  el.innerHTML = '<h1 style="margin:0;font-size:22px"></h1><p style="margin:0;max-width:340px;color:#bbb"></p><div style="display:flex;gap:10px"></div>'
  el.querySelector('h1')!.textContent = title
  el.querySelector('p')!.textContent = text
  for (const b of buttons) {
    const btn = Object.assign(document.createElement('button'), { textContent: b.label })
    btn.style.cssText = 'padding:6px 16px;border-radius:6px;border:0;background:#0a84ff;color:#fff;font:inherit'
    btn.addEventListener('click', () => (el.remove(), b.run()))
    el.querySelector('div')!.append(btn)
  }
  document.body.append(el)
  return el
}

async function boot(): Promise<void> {
  progress('Starting', 0.05)
  const worker = new Worker('/os/worker.js', { type: 'module' })
  const kernel = createKernel(worker, { hostUrl: '/os/host.html' })
  kernel.onEvent((e) => {
    if (e.type === 'system' && e.event === 'progress') progress(e.stage, e.fraction)
  })
  running = { shutdown: async () => (await kernel.shutdown().catch(() => {}), worker.terminate()) }
  await kernel.boot({ namespace, system: { safeMode: params.has('safe'), lastExitClean: exitedCleanly() } })
  attachDrivers(kernel, { capture: false })

  const desktop = new Desktop(kernel, root)
  window.tiny = desktop
  await desktop.start()
  root.hidden = false
  await desktop.serveSessionManager()

  // The tab cannot power anything off: Vanilla tells us, and we show the screen.
  window.addEventListener('tiny:power', (ev) => {
    const action = (ev as CustomEvent).detail.action as string
    void (async () => {
      await kernel.shutdown().catch(() => {})
      worker.terminate()
      if (action === 'restart') return location.reload()
      notice('Pear is powered off', 'Your files and settings are saved in this browser.', [{ label: 'Power On', run: () => location.reload() }])
    })()
  })

  const info = await kernel.bootInfo()
  const session = await kernel.lookup('tiny.session').then(async (port) => ((await kernel.request(port, { op: 'load' }, { timeout: 5000 })).data as { result: any }).result)
  const policy = await kernel.lookup('tiny.session').then(async (port) => ((await kernel.request(port, { op: 'restorePolicy' }, { timeout: 5000 })).data as { result: string }).result)
  const finish = async (restore: boolean) => {
    if (restore && session?.state) await desktop.restore(session.state)
    else if (info.firstBoot) await desktop.firstRun()
    await kernel.lookup('tiny.session').then((port) => kernel.request(port, { op: 'login' }, { timeout: 8000 })).catch(() => {})
  }
  bootEl.classList.add('done')
  setTimeout(() => bootEl.remove(), 500)
  if (policy === 'ask' && session?.state) {
    notice('Pear quit unexpectedly', 'Do you want to reopen the windows you had?', [
      { label: 'Don’t Reopen', run: () => void finish(false) },
      { label: 'Reopen', run: () => void finish(true) },
    ])
  } else await finish(policy === 'restore')
  ;(window as unknown as { tinyReady: boolean }).tinyReady = true
}

void (async () => {
  root.hidden = true
  const guard = await guardTabs(namespace, () => {
    notice('Pear is open in another tab', 'This tab was closed so the other can use your files.', [])
    const done = running?.shutdown()
    return done
  })
  const start = () => boot().catch((e) => {
    console.error(e)
    stage.textContent = `Could not start: ${(e as Error).message}`
  })
  if (guard.owner) return void start()
  bootEl.classList.add('done')
  notice('Pear is already open', 'Pear is running in another tab. Use it here instead?', [
    { label: 'Use Here', run: () => void guard.takeOver().then(() => { bootEl.classList.remove('done'); void start() }) },
  ])
})()
