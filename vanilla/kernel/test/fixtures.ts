import { test as base, expect, type Page } from '@playwright/test'

import type { Kernel } from '../src/client'
import type { ExitStatus, SpawnOptions } from '../src/process'
import { installHelpers } from './helpers'

/** Helpers the harness page installs next to `window.kernel`. */
export interface Shell {
  /** Write a program (an ES module) into the VFS. */
  install(path: string, code: string): Promise<void>
  /** Spawn a program and wait for it to finish. */
  run(path: string, opts?: SpawnOptions): Promise<ExitStatus>
  cat(path: string): Promise<string>
  /** Resolve once `path` exists. */
  waitFor(path: string, ms?: number): Promise<true>
  sleep(ms: number): Promise<void>
  /** Install the shell and core utilities into /bin; resolves with their names. */
  installUserland(): Promise<string[]>
  /** Kill the kernel Worker without shutting down, and boot a new one on the same storage. */
  crash(namespace: string, opts?: { system?: boolean }): Promise<import('../src/fs').Recovery>
  /** Blob file names OPFS holds for a namespace. */
  blobNames(namespace: string): Promise<string[]>
  /** Run input in an interactive shell on a terminal (no prompts, no echo); resolves with its output once it exits. */
  session(input: string, env?: Record<string, string>): Promise<{ out: string; code: number | null; signal: string | null }>
  /** Read a pipe/terminal fd until `needle` appears; resolves with the text up to and including it. */
  expect(fd: number, needle: string, ms?: number): Promise<string>
  /**
   * Install an app bundle named after the last part of `id`, whose entry module is `main`. `extra` goes into the manifest.
   * `grant` gives it every permission it declares.
   */
  app(id: string, main: string, extra?: Record<string, unknown>, grant?: boolean): Promise<import('../src/bundle').BundleInfo>
}

declare global {
  interface Window {
    kernel: Kernel
    sh: Shell
    harnessReady: boolean
    hostTransfer: typeof import('../src/host-transfer')
    guardTabs: typeof import('../src/tab-lock').guardTabs
    attachDrivers(opts?: import('../src/drivers-page').DriverOptions): () => void
  }
}

let counter = 0

/** Each test gets its own OPFS namespace and a freshly booted kernel. */
export const test = base.extend<{ ns: string; page: Page; system: boolean; helpers: boolean }>({
  /** `test.use({ system: true })` runs the boot sequence (hierarchy, userland, services). */
  system: [false, { option: true }],
  /** `test.use({ helpers: true })` (with `system`) also installs `window.ask`, `inbox` and `runApp`. */
  helpers: [false, { option: true }],
  ns: async ({}, use, info) => {
    await use(`t${info.workerIndex}-${Date.now()}-${counter++}`)
  },
  page: async ({ page, ns, system, helpers }, use) => {
    await page.goto('/')
    await page.waitForFunction(() => window.harnessReady)
    await page.evaluate(([ns, system]) => window.kernel.boot({ namespace: ns, system }), [ns, system] as const)
    if (helpers) await installHelpers(page)
    await use(page)
    await page.evaluate(() => window.kernel.shutdown({ destroy: true }).catch(() => {}))
  },
})

export { expect }

/** Source prepended to test programs that run inside the VFS (they cannot import): small helpers, and `find` retries until a service shows up. */
export const PRELUDE = `
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const find = async (t, name) => {
  for (let i = 0; i < 400; i++) {
    try { return await t.lookup(name) } catch (e) { if (e.code !== 'ENOENT') throw e; await sleep(10) }
  }
  throw new Error('service never appeared: ' + name)
}
const code = (p) => p.then(() => 'ok', (e) => e.code)
const out = (t, name, v) => t.writeFile('/tmp/' + name, new TextEncoder().encode(JSON.stringify(v)))
const enc = new TextEncoder()
const dec = new TextDecoder()
`
