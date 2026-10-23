/// The lock screen. The session service owns the state (and the password); this draws the screen and asks it to unlock.
import type { Kernel } from '../../../vanilla/kernel/src/client'

export class LockScreen {
  private el: HTMLElement | null = null
  private clock: ReturnType<typeof setInterval> | undefined

  constructor(private kernel: Kernel, private userName: () => string) {}

  /** Follow the session service: show the screen on `locked`, remove it on `unlocked`. */
  async start(): Promise<void> {
    const k = this.kernel
    const service = await k.lookup('tiny.session')
    const port = await k.portCreate()
    await k.request(service, { op: 'subscribe' }, { rights: [port], timeout: 5000 })
    const state = ((await k.request(service, { op: 'state' }, { timeout: 5000 })).data as { result: { locked: boolean } }).result
    if (state.locked) this.show()
    void (async () => {
      for (;;) {
        const m = await k.receive(port).catch(() => null)
        if (!m) return
        const type = (m.data as { type: string }).type
        if (type === 'locked') this.show()
        else if (type === 'unlocked') this.hide()
      }
    })()
  }

  async lock(): Promise<void> {
    const service = await this.kernel.lookup('tiny.session')
    await this.kernel.request(service, { op: 'lockScreen' }, { timeout: 5000 })
  }

  private async show(): Promise<void> {
    if (this.el) return
    const k = this.kernel
    const service = await k.lookup('tiny.session')
    const hasPassword = ((await k.request(service, { op: 'hasPassword' }, { timeout: 5000 })).data as { result: boolean }).result
    const el = Object.assign(document.createElement('div'), { id: 'lock' })
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-label', 'Lock Screen')
    el.innerHTML = `<div class="lock-time"></div><div class="lock-date"></div><div class="lock-user"></div><form class="lock-form"><input type="password" placeholder="Password" aria-label="Password" autocomplete="off"><button type="submit">${hasPassword ? 'Unlock' : 'Click to Unlock'}</button></form><div class="lock-error" role="alert"></div>`
    const input = el.querySelector('input')!
    input.hidden = !hasPassword
    el.querySelector('.lock-user')!.textContent = this.userName()
    const tick = () => {
      const now = new Date()
      el.querySelector('.lock-time')!.textContent = now.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
      el.querySelector('.lock-date')!.textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })
    }
    tick()
    this.clock = setInterval(tick, 5000)
    el.querySelector('form')!.addEventListener('submit', async (e) => {
      e.preventDefault()
      const reply = (await k.request(service, { op: 'unlock', password: input.value }, { timeout: 5000 })).data as { ok: boolean }
      if (!reply.ok) {
        el.querySelector('.lock-error')!.textContent = 'Incorrect password'
        input.value = ''
        input.focus()
      }
    })
    document.body.append(el)
    this.el = el
    ;(hasPassword ? input : el.querySelector('button')!).focus()
  }

  private hide(): void {
    clearInterval(this.clock)
    this.el?.remove()
    this.el = null
  }
}
