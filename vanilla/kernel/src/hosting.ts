/// How a process gets a place to run. The kernel Worker cannot create frames, so it asks the
/// page that owns it (`host-manager.ts`) to start each process inside a sandboxed iframe
/// (`host-page.ts`). The only thing that crosses that boundary is the MessagePort in the init message.

/** Handle on a started process container. */
export interface HostHandle {
  /** Destroy the container and everything running in it. Safe to call twice. */
  terminate(): void
  /** The container failed outside the program's control (bad program source, Worker failure). */
  onerror: ((message: string) => void) | null
}

export interface ProcessHost {
  /** `init` is delivered to the process runtime; `transfer` lists its transferable parts. */
  start(init: unknown, transfer: Transferable[], runtimeUrl: string): HostHandle
}

/** Kernel Worker -> page. */
export type HostRequest =
  | { host: 'spawn'; id: number; runtimeUrl: string; init: unknown }
  | { host: 'kill'; id: number }

/** Page -> kernel Worker. */
export type HostEvent = { host: 'error'; id: number; message: string }

/** The kernel Worker's side: forwards starts and kills to the page. */
export class RemoteHost implements ProcessHost {
  private nextId = 1
  private handles = new Map<number, HostHandle>()

  constructor(private post: (req: HostRequest, transfer: Transferable[]) => void) {}

  start(init: unknown, transfer: Transferable[], runtimeUrl: string): HostHandle {
    const id = this.nextId++
    const handle: HostHandle = {
      onerror: null,
      terminate: () => {
        if (!this.handles.delete(id)) return
        this.post({ host: 'kill', id }, [])
      },
    }
    this.handles.set(id, handle)
    this.post({ host: 'spawn', id, runtimeUrl, init }, transfer)
    return handle
  }

  handleEvent(ev: HostEvent): void {
    this.handles.get(ev.id)?.onerror?.(ev.message)
  }
}
