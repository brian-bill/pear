/// Only one Pear instance may run on a given storage namespace. The page holds a Web Lock for as long as it is
/// the owner; a second tab asks to be told (and may take over). Call before `kernel.boot`.

export interface TabGuard {
  /** True if this tab got the lock. Otherwise nothing should boot: show "Pear is already open". */
  owner: boolean
  /** Ask the owner to let go, then wait for the lock. Resolves once this tab owns it. */
  takeOver(): Promise<void>
  /** Let go (the tab is closing, or the kernel shut down). */
  release(): void
}

/**
 * `onTakenOver` runs in the owner when another tab takes over: it should shut the kernel down and show the
 * "Pear is now open in another tab" screen. Returning a promise pulses the takeover: the new tab waits for
 * the shut down (or three seconds) before it boots, so it never races the old tab's flush.
 * Without Web Locks every tab counts as the owner.
 */
export async function guardTabs(namespace = 'tiny', onTakenOver?: () => void | Promise<void>): Promise<TabGuard> {
  const name = `tiny:${namespace}:instance`
  const locks = (navigator as Navigator & { locks?: LockManager }).locks
  if (!locks || typeof BroadcastChannel === 'undefined') return { owner: true, takeOver: async () => {}, release: () => {} }
  const channel = new BroadcastChannel(name)
  let release: (() => void) | null = null

  const acquire = (opts: LockOptions) =>
    new Promise<boolean>((resolve) => {
      void locks.request(name, opts, (lock) => {
        if (!lock) return void resolve(false)
        resolve(true)
        return new Promise<void>((done) => (release = done))
      }).catch(() => resolve(false))
    })

  const owner = await acquire({ ifAvailable: true })
  channel.onmessage = (ev) => {
    if (ev.data === 'take-over' && owner) {
      Promise.resolve()
        .then(() => onTakenOver?.())
        .then(() => channel.postMessage('released'))
        .catch(() => {})
        .finally(() => release?.())
    }
  }
  const guard: TabGuard = {
    owner,
    async takeOver() {
      if (guard.owner) return
      channel.postMessage('take-over')
      // The owner lets go after its kernel shut down (which acks). A crashed owner never will,
      // so fall back to plain acquisition: Web Locks release when the tab dies regardless.
      await Promise.race([
        new Promise<void>((resolve) => {
          const hop = (ev: MessageEvent) => {
            if (ev.data === 'released') {
              channel.removeEventListener('message', hop)
              resolve()
            }
          }
          channel.addEventListener('message', hop)
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 3000)),
      ])
      if (await acquire({})) guard.owner = true
    },
    release: () => {
      release?.()
      release = null
      guard.owner = false
    },
  }
  if (typeof window !== 'undefined') window.addEventListener('pagehide', () => release?.())
  return guard
}
