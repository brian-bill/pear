# Vanilla

Vanilla is the core operating system of [Pear](../README.md), a lightweight macOS-inspired OS that runs entirely in the browser. It is a derivative of Darwin, Apple's open-source operating system, reimplemented for the web platform.

## What Vanilla is

Vanilla provides everything below the user interface:

- A small kernel with a process model and message-passing IPC
- A Unix-style virtual file system persisted in OPFS
- A stable syscall interface for the Desktop and apps
- Drivers that adapt browser APIs (display, input, audio, clipboard, timers)
- A POSIX-flavoured shell and core utilities
- System services (launch, settings, notifications, app registry)

The [Desktop](../desktop/) layer, and every app, talks to Vanilla only through its syscall interface.

## What Vanilla is not

- It does not run native macOS or Darwin binaries.
- It does not boot on real hardware. The "hardware" is the browser.
- It is not a full POSIX implementation. It covers what Pear's userland needs.

## Architecture

```
┌──────────────────────────────────────────┐
│  Desktop + Apps                          │
├──────────────────────────────────────────┤
│  Syscall interface                       │
├───────────┬───────────┬──────────────────┤
│  Kernel   │   VFS     │  System services │
│ (procs,   │ (files,   │  (launch,        │
│  IPC)     │  perms)   │   settings, ...) │
├───────────┴───────────┴──────────────────┤
│  Drivers (display, input, audio, ...)    │
├──────────────────────────────────────────┤
│  Browser: Wasm · WebGL · OPFS ·          │
│  LocalStorage · Web Workers              │
└──────────────────────────────────────────┘
```

### Kernel

- Each process runs in its own **Web Worker** inside a sandboxed iframe, isolated from the UI thread, the kernel's storage, the network, and other processes.
- Processes communicate through **message passing**, inspired by Mach ports.
- A scheduler tracks process state (running, waiting, exited) and handles spawn, signal, and exit.
- Performance-sensitive components are compiled to **WebAssembly**.

### Virtual file system

- Unix-style hierarchy with the usual top-level layout:

  ```
  /
  ├── System/         OS files (read-only to users)
  ├── Applications/   installed apps
  ├── Users/<name>/   home directory (Documents, Desktop, ...)
  ├── tmp/            temporary files
  └── dev/            device nodes
  ```
- Files, directories, symlinks, permissions, and timestamps.
- Backed by **OPFS**: the Rust VFS engine runs in the kernel Worker and uses synchronous access handles. Metadata lives in an index (with a write-ahead log) separate from file contents, so listings stay cheap.
- All access is asynchronous and goes through the syscall layer.

### Syscall interface

A small, documented set of calls:

| Area | Calls |
|------|-------|
| Files | `open`, `read`, `write`, `close`, `stat`, `readdir`, `mkdir`, `unlink`, `rename` |
| Processes | `spawn`, `exit`, `kill`, `wait`, `getpid` |
| IPC | `port_create`, `send`, `receive` |
| System | `getenv`, `setenv`, `time`, `config_get`, `config_set` |

### Configuration

System and user settings (theme, dock layout, window state, last session) live in **LocalStorage** under namespaced keys and are exposed through `config_get` / `config_set`. Small, synchronous reads at boot keep startup fast.

### Drivers

Thin adapters that present browser capabilities as services over IPC (`tiny.display`, `tiny.input`, `tiny.audio`, `tiny.clipboard`, `tiny.timers`). The services run as sandboxed processes with no DOM; `attachDrivers(kernel)` runs on the page and connects them to the browser:

| Driver | Browser API |
|--------|-------------|
| Display | Canvas / WebGL, Fullscreen, `getDisplayMedia` |
| Input | Keyboard, pointer, touch, gamepad, IME events, pointer lock |
| Audio | Web Audio, `getUserMedia`, `setSinkId` |
| Clipboard | Async Clipboard, paste and drop events |
| Timers | `setTimeout`, `requestAnimationFrame`, `requestIdleCallback`, Wake Lock, visibility |

### Shell and userland

A terminal-friendly shell with core utilities (`ls`, `cat`, `cp`, `mv`, `rm`, `mkdir`, `echo`, `ps`, `kill`, ...), compiled to WebAssembly where practical.

## Boot

1. Instantiate the kernel (Wasm).
2. Open OPFS; create the default hierarchy on first run.
3. Read configuration from LocalStorage.
4. Start system services as Workers.
5. Hand control to the Desktop.

## Getting started

### Prerequisites

- **Node.js** 20+ and **pnpm**
- **Rust** (via [rustup](https://rustup.rs)) and [wasm-pack](https://rustwasm.github.io/wasm-pack/) — to build and test the file system engine
- **Google Chrome** — the browser test suite drives your installed Chrome; no browser download is needed

### Build

```bash
pnpm install                       # from the repository root

cd vanilla/kernel
pnpm build:wasm                    # compile the Rust VFS engine to WebAssembly
pnpm build                         # bundle the kernel, services and userland into dist/
```

### Testing the kernel locally

The kernel is tested at three layers, from the inside out:

```bash
# 1. Rust engine tests — file system semantics, crash recovery, hardening
cd vanilla
cargo test                         # 89 tests, no browser needed

# 2. WebAssembly + browser tests — the kernel on real OPFS in Chrome
cd kernel
pnpm build:wasm                    # rebuild after any Rust change
pnpm test                          # 242 Playwright tests: file system on real OPFS,
                                   # processes, IPC, bundles, permissions, settings,
                                   # boot, drivers, volumes, images
```

The browser tests build the kernel automatically and serve it on `http://localhost:4173`, so one command is enough once the Wasm is in place. The full desktop experience (window manager, apps, dock) is exercised end to end by the Desktop suite:

```bash
cd ../../desktop
pnpm test                          # 104 end-to-end tests of the whole OS
```

### Using the kernel from JavaScript

```ts
import { createKernel } from './src/client'

const kernel = createKernel(new Worker('./worker.js', { type: 'module' }))
await kernel.boot()
await kernel.mkdir('/Users/me/Documents', { recursive: true })
await kernel.writeFile('/Users/me/Documents/hi.txt', new TextEncoder().encode('hello'))
console.log(await kernel.readdir('/Users/me/Documents'))
```

Booting the whole system, installing apps, and handling permission prompts:

```ts
await kernel.boot({ namespace: 'tiny', system: true })   // hierarchy, /bin, services; without `system` you get the bare kernel
console.log(await kernel.bootInfo())                      // { firstBoot, previousShutdown, services, ... }

await kernel.bundleInstall({ files: { 'manifest.json': JSON.stringify({ id: 'com.example.notes', name: 'Notes', version: '1.0.0',
  permissions: ['clipboard'], documentTypes: [{ ext: ['txt'], role: 'editor' }] }), 'main.js': appSource } })
await kernel.launchOpen('/Users/pear/Documents/a.txt')    // starts Notes with the file (or hands it to the running Notes)

await kernel.permSetPrompter(true)                        // the host shows prompts for { type: 'permission', event: 'prompt' } events
kernel.onEvent((e) => e.type === 'permission' && e.event === 'prompt' && kernel.permRespond(e.id, 'granted'))
```

An app runs as the user, confined to its container, `/tmp`, and what it was granted; a program started with `spawn` from the host is root unless you pass `{user: 'tiny'}`.

### Writing a program

A program is an ES module in the VFS. It receives a `tiny` object (`kernel/src/runtime.ts` has the full type):

```js
export default async (tiny) => {
  const name = tiny.args[0] ?? 'world'
  await tiny.writeFile('hello.txt', new TextEncoder().encode(`hello ${name}`)) // relative to cwd
  console.log('done')                  // captured as stdout
  tiny.onSignal('SIGTERM', async () => { /* clean up */ await tiny.exit(0) })
  const child = await tiny.spawn('/Applications/other.js', { args: ['x'] })
  const { code, stdout } = await tiny.wait(child)
  return code                          // exit code
}
```

Programs talk to each other through ports:

```js
// service
const port = await tiny.portCreate()          // you own it: only you can receive on it
await tiny.register('my.service', port)
const msg = await tiny.receive(port)          // { data, from, rights, replyTo }
await tiny.send(msg.replyTo, { ok: true })

// client
const svc = await tiny.lookup('my.service')   // lookup grants a send right
const reply = await tiny.request(svc, { hello: 1 }, { timeout: 5000 })
```

A process can send only to ports it was given: by `lookup`, by creating them, or in a message's `rights`. Ports die with their owner (`EPIPE`). The outside (Desktop, tests) uses the same calls on `kernel`: `kernel.spawn(path, {args, env, cwd})`, `kernel.kill(pid, 'SIGTERM')`, `kernel.wait(pid)`, `kernel.listProcesses()`, `kernel.onEvent(cb)`.

Ports can move big payloads without copying (`send(port, data, {transfer: [buffer]})`), wait for a full queue (`{timeout}`), and tell you when a peer dies (`watch(port, notifyPort)` delivers `{type: 'dead-name', port}`). `tiny.ping(pid)` measures responsiveness; `kernel.processInfo(pid).unresponsive` is the flag the Desktop uses for "Not Responding".

**Processes are sandboxed.** Each one runs in a hidden `<iframe sandbox="allow-scripts">` (opaque origin, so no OPFS, IndexedDB, or storage) with a CSP of `connect-src 'none'` (no `fetch`, WebSocket, or remote imports), and the kernel's `MessagePort` is its only channel out. The page that owns the kernel Worker creates the frames, so `createKernel(worker)` must run on a page, and `dist/host.html` and `dist/process.js` must be served next to it (`createKernel(worker, {hostUrl})` overrides the frame URL). Serve `host.html` with `Content-Security-Policy: sandbox allow-scripts` too. Details and limits (no CPU or memory quotas) are in the [permissions contract](../contracts/permissions.md).

## How the pieces fit

```
Desktop ──postMessage──▶ kernel Worker (src/worker.ts)
                              │  Kernel: ProcessTable + FileSystem
                              │    ProcessTable (process.ts): per-process cwd/env/fds, signals, wait
                              │    FileSystem (fs.ts): serializes calls, retries on EAGAIN, flush + gc
                              ▼
                         Wasm (wasm/): Vfs engine ──▶ OpfsStorage (sync access handles)
                              ▲
                              │ one MessagePort per process (syscalls in, signals out)
                         process Workers (runtime.ts) running programs from the VFS
```

OPFS opens files asynchronously but the engine is synchronous, so a storage call on an unopened file returns `EAGAIN` naming the file. `FileSystem` opens it and retries the whole operation, which is why every engine operation must be retry-safe (no partial state on `EAGAIN`). The unit tests check this with a storage double that behaves like OPFS.

The metadata is a full index (stored in two alternating slots) plus a write-ahead journal: a flush appends one small checksummed record with the inodes that changed, and the index is rewritten only when the journal outgrows it or at shutdown. Mounting replays the journal, drops torn records, and deletes data files that belong to no file. File contents live in separate blobs, deleted only after the metadata that forgets them is durable. Changes become durable on `flush()`, which the Worker also runs on a 250 ms debounce after any call. Details: the [filesystem contract](../contracts/filesystem.md).

## Project layout

```
vanilla/
├── vfs/         file system engine (Rust): Storage trait, in-memory backend
├── wasm/        OPFS Storage backend + wasm-bindgen facade (Rust)
└── kernel/      kernel Worker, RPC client, system services, shell, browser tests (TypeScript)
```

## Documentation

Every subsystem has a contract that describes its behaviour, IPC surface, and guarantees:

[filesystem](../contracts/filesystem.md) · [processes](../contracts/processes.md) · [ipc](../contracts/ipc.md) · [permissions](../contracts/permissions.md) · [app-bundles](../contracts/app-bundles.md) · [launch-services](../contracts/launch-services.md) · [configuration](../contracts/configuration.md) · [boot-and-session](../contracts/boot-and-session.md) · [network](../contracts/network.md) · [timers](../contracts/timers.md) — see the [`contracts/`](../contracts/) directory for the full list.

## Design principles

- **Small.** Prefer fewer, well-defined primitives over feature breadth.
- **Fast.** Lazy-load everything non-essential; keep the boot path short.
- **Isolated.** No shared mutable state between processes.
- **Readable.** The codebase should be a good place to learn how an OS works.
- **Browser-native.** Use platform APIs directly; avoid heavy frameworks.

## Requirements

A current Chromium-based browser with WebAssembly, Web Workers, OPFS, LocalStorage, and WebGL 2.

## License

TBD. As a Darwin derivative, Vanilla's licensing will need to respect the licenses of any Darwin/XNU/BSD code it borrows from (APSL and BSD-style licenses).
