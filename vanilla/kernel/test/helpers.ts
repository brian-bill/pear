import type { Page } from '@playwright/test'

declare global {
  interface Window {
    /** Ask a system service: the result, or `{error: code}`. `rights` are ports to pass along. */
    ask(name: string, msg: Record<string, unknown>, rights?: number[]): Promise<any>
    /** A port init owns, plus `next(ms)` to read what arrives on it. */
    inbox(): Promise<{ port: number; next(ms?: number): Promise<any>; all(ms?: number): Promise<any[]> }>
    /** Run `main` as an app named `id`; resolves with what it wrote to /tmp/<id>.out (JSON). */
    runApp(id: string, main: string, extra?: Record<string, unknown>, grant?: boolean): Promise<any>
  }
}

/** Install `ask`, `inbox` and `runApp` on the page (the kernel must be booted with `system: true`). */
export async function installHelpers(page: Page): Promise<void> {
  await page.evaluate(() => {
    // `window.kernel` is looked up on each call: a simulated crash replaces it
    const kernel = () => window.kernel
    window.ask = async (name, msg, rights) => {
      const k = kernel()
      const reply = (await k.request(await k.lookup(`tiny.${name}`), msg, { rights, timeout: 8000 })).data as any
      return reply.ok ? reply.result : { error: reply.error.code }
    }
    window.inbox = async () => {
      const k = kernel()
      const port = await k.portCreate()
      const next = (ms = 1500) => k.receive(port, { timeout: ms }).then((m) => m.data, () => null)
      const all = async (ms = 300) => {
        const out: any[] = []
        for (;;) {
          const d = await next(ms)
          if (d === null) return out
          out.push(d)
        }
      }
      return { port, next, all }
    }
    window.runApp = async (id, main, extra, grant) => {
      const k = kernel()
      const installed = (await k.bundleList()).find((b) => b.id === id)
      const info = installed ?? (await window.sh.app(id, main, extra, grant))
      const pid = await k.launchOpen(info.id)
      const st = await k.wait(pid)
      if (st.code !== 0) throw new Error(`app failed: ${st.stderr}`)
      return JSON.parse(await window.sh.cat(`/tmp/${id}.out`))
    }
  })
}
