# Deploying the Vanilla kernel

The kernel ships as static files. There is no server-side code: the browser runs everything.

## 1. Build

```bash
cd vanilla/kernel
pnpm install
pnpm build:wasm      # needs wasm-pack; produces pkg/
pnpm build           # produces dist/
```

`pnpm build` regenerates `dist/host.html` on every run. Its CSP contains the SHA-256 of the inline script, so **never edit `host.html` by hand or copy an old one next to a new build**: the script would be blocked and every `spawn` would crash.

## 2. Files to publish

Serve all of `dist/` from one directory:

| File | Used by |
|------|---------|
| `worker.js` | the kernel Worker (file system, processes, IPC) |
| `tiny_vanilla_bg.wasm` | loaded by the kernel Worker; serve as `application/wasm` |
| `process.js` | the process runtime; the page fetches its text once and gives it to each frame |
| `host.html` | the sandboxed page each process runs in |
| `userland.json` | the shell and core utilities (`sh`, `ls`, `cat`, ...) as one JSON file; Desktop writes them into `/bin` on first run with `installUserland(kernel, url)` from `src/userland.ts` |
| `main.js`, `index.html` | the test harness only; replace with Desktop's own page |

Your page creates the kernel with:

```ts
const kernel = createKernel(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }))
// host.html is found next to the script by default; override if it lives elsewhere:
// createKernel(worker, { hostUrl: '/vanilla/host.html' })
await kernel.boot()
```

`createKernel` must run on a page (it creates the iframes), not inside another Worker.

## 3. Required headers

**`host.html` must be sent with:**

```
Content-Security-Policy: sandbox allow-scripts
```

This forces the sandbox even if someone opens the file directly or embeds it without the `sandbox` attribute. Without it a directly opened `host.html` runs with your origin. `serve.mjs` shows the minimal version. The CSP inside the file itself (`connect-src 'none'`, hashed script) is what blocks the network, and it does not need a header.

Everything else is plain static content. Suggested types: `.js` as `text/javascript`, `.wasm` as `application/wasm`, `.html` as `text/html`.

## 4. If your page has its own CSP or isolation headers

- `frame-src` must allow the URL of `host.html` (or `'self'`).
- `worker-src` must allow the kernel Worker (`'self'`).
- `connect-src` must allow fetching `process.js`.
- `script-src` needs `'wasm-unsafe-eval'` for the kernel's WebAssembly.
- If the page is cross-origin isolated (COOP/COEP `require-corp`), serve `host.html` with `Cross-Origin-Embedder-Policy: require-corp` and `Cross-Origin-Resource-Policy: same-origin` too, or the browser will refuse to load the frame.
- Do **not** add `allow-same-origin` to the iframe or to the `sandbox` header. That would give processes the kernel's origin and defeat the isolation.

## 5. Browser support

Chrome/Chromium is the only browser tested. It needs OPFS with sync access handles inside Workers. Firefox is untested and Safari is not a target.

## 6. Verify a deployment

1. Open the page and boot the kernel, then `kernel.writeFile('/a.js', ...)` with a program that logs, and spawn it. If the process exits with `crashed: true` and error `worker error`, the CSP hash in `host.html` does not match its script (stale file) or a header blocks the frame.
2. In DevTools, confirm the process frame's origin is `null` (a hidden `<iframe>` per running process; they disappear when the process exits).
3. Run `pnpm test` against the same build. The isolation tests in `test/processes.spec.ts` try OPFS, `fetch`, WebSocket, IndexedDB, and remote imports from inside a process and expect every one to be blocked.

## Notes

- **Isolation:** each process runs in a sandboxed iframe (opaque origin) with a classic Worker inside. The kernel's `MessagePort` is its only way out. The design and its limits are in `contracts/permissions.md`.
- **Quotas:** there are no CPU or memory limits per process yet. A hostile program can still burn CPU or memory until it is killed. The heartbeat marks it `unresponsive`; `SIGKILL` removes its frame.
- **Userland:** `pnpm build` bundles `userland/*.ts` into `dist/userland.json`. Programs live in the VFS, not in the page, so an update to the shell reaches existing users only when `installUserland` runs again (it overwrites `/bin/*`); do this after each deploy that changes `userland/`.
- **Spawn cost:** every `spawn` loads an iframe, so it is slower than a bare Worker. The process runtime is fetched once and cached by the page.
- **Process limit:** 64 live processes (`EAGAIN` beyond that).
- **Shared memory:** not available. Use `send(..., { transfer: [buffer] })` for zero-copy handoff (see `contracts/ipc.md`).
- **Heartbeat:** the kernel pings every started process every 1 s and flags it `unresponsive` after 3 s without an answer. Change it with `kernel.boot({ heartbeat: { interval, timeout } })` or turn it off with `heartbeat: false`.
- **Upgrading the engine:** volumes written by the previous release are upgraded in place on the next flush and cannot be opened by the old release afterwards, so roll back by restoring storage, not by redeploying the old build. After an unclean shutdown the first boot replays the journal and deletes leftover data files; `kernel.fsInfo().recovery` says what it did.
- **Data lives in OPFS** under the namespace given to `boot({ namespace })`. Clearing site data deletes the whole virtual disk, and `shutdown({ destroy: true })` does too.
- **Updating:** a new build can be deployed by replacing `dist/`. Keep `host.html`, `process.js`, and `worker.js` from the same build (cache-bust them together), since the process protocol is not versioned.
