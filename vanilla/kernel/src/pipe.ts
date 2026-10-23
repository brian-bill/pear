/// Pipes and the stdio endpoints built on them. An `Endpoint` is one open descriptor: a process holds
/// them in its fd table and as stdin/stdout/stderr. Pipes count their open ends, so the last writer
/// closing gives readers EOF, and writing with no reader left is `EPIPE`.
import { SysError } from './errors'
import { O, type FileSystem } from './fs'
import type { Pty } from './pty'

/** Bytes a pipe buffers before writers have to wait for a reader. */
const PIPE_CAPACITY = 64 * 1024

export interface ReadWaiter {
  owner: Endpoint
  max: number
  resolve: (data: Uint8Array) => void
  reject: (e: Error) => void
}

interface WriteWaiter {
  owner: Endpoint
  data: Uint8Array
  off: number
  resolve: () => void
  reject: (e: Error) => void
}

/** Fail the operations a closed descriptor still had waiting. */
export function cancelWaiters(waiters: Array<{ owner: Endpoint; reject: (e: Error) => void }>, ep: Endpoint): void {
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i]!.owner !== ep) continue
    waiters[i]!.reject(new SysError('EBADF', 'descriptor was closed'))
    waiters.splice(i, 1)
  }
}

export class Pipe {
  private chunks: Uint8Array[] = []
  private size = 0
  private readWaiters: ReadWaiter[] = []
  private writeWaiters: WriteWaiter[] = []
  /** Open read and write descriptors. */
  readers = 0
  writers = 0

  /** Up to `max` bytes. An empty result is EOF: the buffer is empty and no writer is left. */
  read(owner: Endpoint, max: number): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      this.readWaiters.push({ owner, max, resolve, reject })
      this.settle()
    })
  }

  /** Resolves once all of `data` is in the buffer (waiting for a reader if it is full). */
  write(owner: Endpoint, data: Uint8Array): Promise<void> {
    if (this.readers === 0) return Promise.reject(new SysError('EPIPE', 'pipe has no reader'))
    return new Promise((resolve, reject) => {
      this.writeWaiters.push({ owner, data, off: 0, resolve, reject })
      this.settle()
    })
  }

  /** An end was closed: forget what it was waiting for and tell the other side. */
  closeEnd(ep: Endpoint, mode: 'r' | 'w'): void {
    if (mode === 'r') {
      this.readers--
      cancelWaiters(this.readWaiters, ep)
      if (this.readers === 0) {
        this.chunks = []
        this.size = 0
        for (const w of this.writeWaiters.splice(0)) w.reject(new SysError('EPIPE', 'pipe has no reader'))
      }
    } else {
      this.writers--
      cancelWaiters(this.writeWaiters, ep)
    }
    this.settle()
  }

  private take(max: number): Uint8Array {
    const n = Math.min(max, this.size)
    const out = new Uint8Array(n)
    let at = 0
    while (at < n) {
      const head = this.chunks[0]!
      const part = Math.min(head.length, n - at)
      out.set(head.subarray(0, part), at)
      at += part
      if (part === head.length) this.chunks.shift()
      else this.chunks[0] = head.subarray(part)
    }
    this.size -= n
    return out
  }

  /** Move data from blocked writers into the buffer and out to waiting readers, in arrival order. */
  private settle(): void {
    for (let progress = true; progress; ) {
      progress = false
      while (this.writeWaiters.length && this.size < PIPE_CAPACITY) {
        const w = this.writeWaiters[0]!
        const n = Math.min(PIPE_CAPACITY - this.size, w.data.length - w.off)
        if (n > 0) {
          this.chunks.push(w.data.subarray(w.off, w.off + n))
          this.size += n
          w.off += n
          progress = true
        }
        if (w.off >= w.data.length) {
          this.writeWaiters.shift()
          w.resolve()
          progress = true
        }
      }
      while (this.readWaiters.length && this.size > 0) {
        const r = this.readWaiters.shift()!
        r.resolve(this.take(r.max))
        progress = true
      }
    }
    if (this.size === 0 && this.writers === 0) for (const r of this.readWaiters.splice(0)) r.resolve(new Uint8Array(0))
  }
}

/** A file shared by several stdio endpoints (a child inherited it), closed with the last one. */
interface SharedFile {
  fd: number
  refs: number
  /** Operations on one open file run in the order they were issued. */
  chain: Promise<unknown>
}

export type Endpoint =
  | { kind: 'null' }
  /** Output kept for `wait`: the sink appends to a process's capture buffer. */
  | { kind: 'capture'; sink: (text: string) => void; decoder: TextDecoder }
  | { kind: 'pipe'; pipe: Pipe; mode: 'r' | 'w' }
  | { kind: 'file'; file: SharedFile; mode: 'r' | 'w' }
  /** One side of a pseudo-terminal: the master is the terminal emulator's, the slave is a program's stdio. */
  | { kind: 'pty'; pty: Pty; side: 'master' | 'slave' }

export const nullEndpoint = (): Endpoint => ({ kind: 'null' })
export const captureEndpoint = (sink: (text: string) => void): Endpoint => ({ kind: 'capture', sink, decoder: new TextDecoder() })

export function pipeEndpoints(): { read: Endpoint; write: Endpoint } {
  const pipe = new Pipe()
  pipe.readers++
  pipe.writers++
  return { read: { kind: 'pipe', pipe, mode: 'r' }, write: { kind: 'pipe', pipe, mode: 'w' } }
}

export async function openFileEndpoint(fs: FileSystem, path: string, mode: 'r' | 'w', append = false): Promise<Endpoint> {
  const flags = mode === 'r' ? O.RDONLY : O.WRONLY | O.CREAT | (append ? O.APPEND : O.TRUNC)
  const fd = await fs.open(path, flags)
  return { kind: 'file', file: { fd, refs: 1, chain: Promise.resolve() }, mode }
}

/** A second descriptor for the same thing (a child inheriting, or `{fd}` handed to `spawn`). */
export function dup(ep: Endpoint): Endpoint {
  switch (ep.kind) {
    case 'null':
      return { kind: 'null' }
    case 'capture':
      return { kind: 'capture', sink: ep.sink, decoder: new TextDecoder() }
    case 'pipe':
      if (ep.mode === 'r') ep.pipe.readers++
      else ep.pipe.writers++
      return { kind: 'pipe', pipe: ep.pipe, mode: ep.mode }
    case 'file':
      ep.file.refs++
      return { kind: 'file', file: ep.file, mode: ep.mode }
    case 'pty':
      ep.pty.open(ep.side)
      return { kind: 'pty', pty: ep.pty, side: ep.side }
  }
}

export async function release(fs: FileSystem, ep: Endpoint): Promise<void> {
  if (ep.kind === 'pipe') ep.pipe.closeEnd(ep, ep.mode)
  else if (ep.kind === 'pty') ep.pty.close(ep, ep.side)
  else if (ep.kind === 'file' && --ep.file.refs === 0) {
    await ep.file.chain.catch(() => {})
    await fs.close(ep.file.fd).catch(() => {})
  }
}

function inOrder<T>(file: SharedFile, op: () => Promise<T>): Promise<T> {
  const done = file.chain.then(op)
  file.chain = done.catch(() => {})
  return done
}

const encoder = new TextEncoder()
const bytes = (data: string | Uint8Array) => (typeof data === 'string' ? encoder.encode(data) : data)

export function writeTo(fs: FileSystem, ep: Endpoint, data: string | Uint8Array): Promise<void> {
  switch (ep.kind) {
    case 'null':
      return Promise.resolve()
    case 'capture':
      ep.sink(typeof data === 'string' ? data : ep.decoder.decode(data, { stream: true }))
      return Promise.resolve()
    case 'pipe':
      if (ep.mode !== 'w') return Promise.reject(new SysError('EBADF', 'not open for writing'))
      return ep.pipe.write(ep, bytes(data))
    case 'pty':
      if (ep.side === 'master') {
        ep.pty.masterWrite(bytes(data))
        return Promise.resolve()
      }
      return ep.pty.slaveWrite(ep, bytes(data))
    case 'file': {
      if (ep.mode !== 'w') return Promise.reject(new SysError('EBADF', 'not open for writing'))
      const buf = bytes(data)
      return inOrder(ep.file, () => fs.write(ep.file.fd, buf)).then(() => {})
    }
  }
}

/** Up to `max` bytes; empty means end of input. */
export function readFrom(fs: FileSystem, ep: Endpoint, max: number): Promise<Uint8Array> {
  switch (ep.kind) {
    case 'null':
      return Promise.resolve(new Uint8Array(0))
    case 'capture':
      return Promise.reject(new SysError('EBADF', 'not open for reading'))
    case 'pipe':
      if (ep.mode !== 'r') return Promise.reject(new SysError('EBADF', 'not open for reading'))
      return ep.pipe.read(ep, max)
    case 'pty':
      return ep.side === 'master' ? ep.pty.masterRead(ep, max) : ep.pty.slaveRead(ep, max)
    case 'file': {
      if (ep.mode !== 'r') return Promise.reject(new SysError('EBADF', 'not open for reading'))
      return inOrder(ep.file, () => fs.read(ep.file.fd, max))
    }
  }
}

export function ptyEndpoints(pty: Pty): { master: Endpoint; slave: Endpoint } {
  // A new Pty starts with one master and one slave open, so no `open` call here.
  return { master: { kind: 'pty', pty, side: 'master' }, slave: { kind: 'pty', pty, side: 'slave' } }
}
