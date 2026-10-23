import { createKernel } from '../../src/client'
import { installUserland } from '../../src/userland'
import { attachDrivers } from '../../src/drivers-page'
import * as hostTransfer from '../../src/host-transfer'
import { guardTabs } from '../../src/tab-lock'

const spawnWorker = () => new Worker(new URL('./worker.js', import.meta.url), { type: 'module' })
let worker = spawnWorker()
let kernel = createKernel(worker)
const enc = new TextEncoder()
const dec = new TextDecoder()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

const sh = {
  install: (path: string, code: string) => kernel.writeFile(path, enc.encode(code)),
  run: async (path: string, opts?: Parameters<typeof kernel.spawn>[1]) => kernel.wait(await kernel.spawn(path, opts)),
  cat: async (path: string) => dec.decode(await kernel.readFile(path)),
  waitFor: async (path: string, ms = 8000) => {
    const start = Date.now()
    while (Date.now() - start < ms) {
      if (await kernel.exists(path)) return true as const
      await sleep(20)
    }
    throw new Error(`timed out waiting for ${path}`)
  },
  sleep,
  /**
   * Simulate a power cut: kill the kernel Worker without a shutdown (no flush, OPFS handles dropped), then
   * start a fresh kernel on the same storage. Returns the new kernel's recovery report.
   */
  crash: async (namespace: string, opts: { system?: boolean } = {}) => {
    worker.terminate()
    document.querySelectorAll('iframe').forEach((f) => f.remove())
    const restart = () => {
      worker = spawnWorker()
      kernel = createKernel(worker)
      window.kernel = kernel
    }
    restart()
    // The old Worker's file handles are released asynchronously.
    for (let attempt = 0; ; attempt++) {
      try {
        await kernel.boot({ namespace, ...opts })
        break
      } catch (e) {
        if (attempt >= 50) throw e
        await sleep(100)
        worker.terminate()
        restart()
      }
    }
    return (await kernel.fsInfo()).recovery
  },
  blobNames: async (namespace: string) => {
    const root = await navigator.storage.getDirectory()
    const data = await (await root.getDirectoryHandle(namespace)).getDirectoryHandle('data')
    const names: string[] = []
    for await (const [name] of (data as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) names.push(name)
    return names.sort()
  },
  app: (id: string, main: string, extra: Record<string, unknown> = {}, grant = false) =>
    kernel.bundleInstall(
      { files: { 'manifest.json': JSON.stringify({ id, name: id.split('.').pop(), version: '1.0.0', entry: 'main.js', ...extra }), 'main.js': main } },
      { grant },
    ),
  installUserland: () => installUserland(kernel),
  /**
   * Run `input` in an interactive shell on a terminal and return everything printed (CRLF line ends) once it
   * exits. Prompts are off and echo is off, so the output is only what the commands printed.
   */
  session: async (input: string, env: Record<string, string> = {}) => {
    const { pid, master } = await kernel.spawnPty('/bin/sh', { env: { PS1: '', PS2: '', ...env } })
    await kernel.tcsetattr(master, { echo: false })
    await kernel.pipeWrite(master, input)
    const parts: string[] = []
    for (;;) {
      const chunk = await kernel.pipeRead(master)
      if (!chunk.length) break
      parts.push(dec.decode(chunk, { stream: true }))
    }
    const st = await kernel.wait(pid)
    return { out: parts.join(''), code: st.code, signal: st.signal }
  },
  /**
   * Read a pipe or terminal descriptor until `needle` has appeared; returns everything up to and including it.
   * Text after the needle stays buffered for the next call. Rejects after `ms`.
   */
  expect: (() => {
    const buffers = new Map<number, string>()
    return async (fd: number, needle: string, ms = 8000) => {
      const read = async () => {
        let text = buffers.get(fd) ?? ''
        while (!text.includes(needle)) text += dec.decode(await kernel.pipeRead(fd))
        const end = text.indexOf(needle) + needle.length
        buffers.set(fd, text.slice(end))
        return text.slice(0, end)
      }
      const timeout = sleep(ms).then(() => {
        throw new Error(`timed out waiting for ${JSON.stringify(needle)}; buffered ${JSON.stringify(buffers.get(fd) ?? '')}`)
      })
      return Promise.race([read(), timeout])
    }
  })(),
}

Object.assign(window, { kernel, sh, hostTransfer, guardTabs, harnessReady: true, attachDrivers: (opts?: Parameters<typeof attachDrivers>[1]) => attachDrivers(window.kernel, opts) })
