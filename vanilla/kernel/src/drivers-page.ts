/// The page's half of the drivers. The driver services (`services/clipboard.ts`, `timers.ts`, `input.ts`, `display.ts`,
/// `audio.ts`) run in sandboxed processes with no access to the DOM, so this module, which runs on the page that owns
/// the kernel Worker, feeds them the browser's events (`kernel.driverPush`) and carries out what they ask
/// (`{type: 'driver'}` kernel events). Call `attachDrivers(kernel)` once after boot; it returns a function that undoes it.
import type { Kernel } from './client'

export interface DriverOptions {
  /** Where pointer, wheel and touch events are listened for, and which element gets the cursor and pointer lock. Default: `document.documentElement`. */
  surface?: HTMLElement
  /** Stop the browser's own scrolling and zooming on the surface (`preventDefault` on wheel and touch). Default true. */
  capture?: boolean
}

const errorCode = (e: unknown): string => {
  const name = (e as { name?: string })?.name
  return name === 'NotAllowedError' || name === 'SecurityError' ? 'EPERM'
    : name === 'NotFoundError' || name === 'OverconstrainedError' ? 'ENOENT'
      : name === 'NotSupportedError' || name === 'TypeError' ? 'ENOSYS'
        : name === 'AbortError' ? 'ECANCELED'
          : 'EIO'
}

const named = (name: string, message: string) => Object.assign(new Error(message), { name })

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> }

export function attachDrivers(kernel: Kernel, opts: DriverOptions = {}): () => void {
  const surface = opts.surface ?? document.documentElement
  const capture = opts.capture ?? true
  const cleanups: Array<() => void> = []
  const on = (target: EventTarget, type: string, fn: (e: any) => void, options?: AddEventListenerOptions) => {
    target.addEventListener(type, fn, options)
    cleanups.push(() => target.removeEventListener(type, fn, options))
  }
  const push = (device: string, data: unknown) => void kernel.driverPush(device, data).catch(() => {})
  const reply = (device: string, id: number, ok: boolean, payload: unknown) =>
    push(device, ok ? { event: 'reply', id, ok, result: payload } : { event: 'reply', id, ok, code: errorCode(payload), message: (payload as Error)?.message })
  const answer = (device: string, id: number | undefined, work: () => Promise<unknown>) => {
    if (id === undefined) return void work().catch(() => {})
    work().then((r) => reply(device, id, true, r), (e) => reply(device, id, false, e))
  }

  // ---------------------------------------------------------------- input
  const pointerKinds: Record<string, string> = { pointerdown: 'down', pointerup: 'up', pointermove: 'move', pointerenter: 'enter', pointerleave: 'leave', pointercancel: 'cancel' }
  const mods = (e: KeyboardEvent | MouseEvent | WheelEvent) => ({ ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, shiftKey: e.shiftKey, fnKey: (e as KeyboardEvent).getModifierState?.('Fn') ?? false })
  let pendingMove: Record<string, unknown> | null = null
  let moveFrame = 0
  const sendInput = (input: Record<string, unknown>) => push('input', { event: 'input', input })
  const flushMove = () => {
    cancelAnimationFrame(moveFrame)
    moveFrame = 0
    if (pendingMove) sendInput(pendingMove)
    pendingMove = null
  }
  const send = (input: Record<string, unknown>) => {
    flushMove() // keep events in order: the latest move goes out before anything that follows it
    sendInput(input)
  }

  on(window, 'keydown', (e: KeyboardEvent) => send({ kind: 'key', phase: e.repeat ? 'repeat' : 'down', code: e.code, key: e.key, ...mods(e), time: e.timeStamp }))
  on(window, 'keyup', (e: KeyboardEvent) => send({ kind: 'key', phase: 'up', code: e.code, key: e.key, ...mods(e), time: e.timeStamp }))
  let composing = false
  on(window, 'compositionstart', (e: CompositionEvent) => ((composing = true), send({ kind: 'composition', phase: 'start', text: e.data ?? '', time: e.timeStamp })))
  on(window, 'compositionupdate', (e: CompositionEvent) => send({ kind: 'composition', phase: 'update', text: e.data ?? '', start: 0, end: (e.data ?? '').length, time: e.timeStamp }))
  on(window, 'compositionend', (e: CompositionEvent) => {
    composing = false
    send({ kind: 'composition', phase: 'end', text: e.data ?? '', time: e.timeStamp })
    if (e.data) send({ kind: 'text', text: e.data, time: e.timeStamp })
  })
  on(window, 'beforeinput', (e: InputEvent) => {
    if (!composing && e.inputType === 'insertText' && e.data) send({ kind: 'text', text: e.data, time: e.timeStamp })
  })
  for (const [type, phase] of Object.entries(pointerKinds)) {
    on(surface, type, (e: PointerEvent) => {
      const input = { kind: 'pointer', phase, x: e.clientX, y: e.clientY, button: e.button, buttons: e.buttons, pressure: e.pressure, pointerType: e.pointerType, pointerId: e.pointerId, ...mods(e), time: e.timeStamp }
      if (type !== 'pointermove') return send(input)
      pendingMove = input
      moveFrame ||= requestAnimationFrame(flushMove)
    })
  }
  on(surface, 'wheel', (e: WheelEvent) => {
    if (capture) e.preventDefault()
    const dm = e.deltaMode
    // trackpads report small, fractional pixel deltas
    const precise = dm === 0 && (!Number.isInteger(e.deltaY) || Math.abs(e.deltaY) < 50)
    send({ kind: 'wheel', dx: e.deltaX, dy: e.deltaY, mode: dm === 1 ? 'line' : dm === 2 ? 'page' : 'pixel', precise, x: e.clientX, y: e.clientY, ...mods(e), time: e.timeStamp })
  }, { passive: false })
  for (const [type, phase] of [['touchstart', 'start'], ['touchmove', 'move'], ['touchend', 'end'], ['touchcancel', 'cancel']] as const) {
    on(surface, type, (e: TouchEvent) => {
      if (capture) e.preventDefault()
      send({ kind: 'touch', phase, points: [...e.touches].map((t) => ({ id: t.identifier, x: t.clientX, y: t.clientY, force: t.force })), time: e.timeStamp })
    }, { passive: false })
  }
  // Safari reports pinch and rotate as gesture events
  for (const [type, phase] of [['gesturestart', 'begin'], ['gesturechange', 'change'], ['gestureend', 'end']] as const) {
    on(surface, type, (e: Event & { scale?: number; rotation?: number; clientX?: number; clientY?: number }) => {
      if (capture) e.preventDefault()
      send({ kind: 'gesture', phase, gesture: (e.rotation ?? 0) !== 0 ? 'rotate' : 'pinch', scale: e.scale ?? 1, rotation: e.rotation ?? 0, x: e.clientX ?? 0, y: e.clientY ?? 0, time: e.timeStamp })
    }, { passive: false })
  }
  // Chrome and Firefox: pinch on a trackpad arrives as a wheel event with ctrlKey set; handled by the wheel listener above (`mods.ctrlKey`)

  const pads = new Set<number>()
  let padFrame = 0
  const pollPads = () => {
    padFrame = 0
    for (const g of navigator.getGamepads?.() ?? []) {
      if (g) send({ kind: 'gamepad', phase: 'state', index: g.index, id: g.id, buttons: g.buttons.map((b) => b.value), axes: [...g.axes], time: performance.now() })
    }
    if (pads.size) padFrame = requestAnimationFrame(pollPads)
  }
  on(window, 'gamepadconnected', (e: GamepadEvent) => {
    pads.add(e.gamepad.index)
    send({ kind: 'gamepad', phase: 'connect', index: e.gamepad.index, id: e.gamepad.id, time: performance.now() })
    padFrame ||= requestAnimationFrame(pollPads)
  })
  on(window, 'gamepaddisconnected', (e: GamepadEvent) => {
    pads.delete(e.gamepad.index)
    send({ kind: 'gamepad', phase: 'disconnect', index: e.gamepad.index, id: e.gamepad.id, time: performance.now() })
  })
  cleanups.push(() => cancelAnimationFrame(padFrame), () => cancelAnimationFrame(moveFrame))

  const hostInfo = () =>
    push('input', {
      event: 'host-info',
      platform: (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
      keyboardLock: 'keyboard' in navigator && 'lock' in (navigator as { keyboard?: object }).keyboard!,
    })
  hostInfo()

  // ---------------------------------------------------------------- display
  const screens = () =>
    push('display', {
      event: 'screens',
      displays: [{
        width: window.innerWidth, height: window.innerHeight, scale: window.devicePixelRatio || 1, refreshRate: 60,
        colorSpace: matchMedia?.('(color-gamut: p3)').matches ? 'display-p3' : 'srgb', fullscreen: Boolean(document.fullscreenElement),
      }],
    })
  screens()
  on(window, 'resize', screens)
  on(document, 'fullscreenchange', screens)
  const watchScale = () => {
    const mq = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    const change = () => (screens(), mq.removeEventListener('change', change), watchScale())
    mq.addEventListener('change', change)
    cleanups.push(() => mq.removeEventListener('change', change))
  }
  watchScale()
  try {
    const gl = document.createElement('canvas').getContext('webgl2') as WebGL2RenderingContext | null
    const ext = gl?.getExtension('WEBGL_debug_renderer_info')
    const renderer = ext && gl ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    push('display', {
      event: 'gpu',
      gpu: {
        vendor: ext && gl ? String(gl.getParameter(ext.UNMASKED_VENDOR_WEBGL)) : '', renderer, webgl2: Boolean(gl),
        maxTextureSize: gl ? Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) : 4096, software: /swiftshader|software|llvmpipe/i.test(renderer),
      },
    })
  } catch {
    // no WebGL: the defaults stand
  }
  on(surface, 'webglcontextlost', (e: Event) => (e.preventDefault(), push('display', { event: 'contextlost' })), { capture: true })
  on(surface, 'webglcontextrestored', () => push('display', { event: 'contextrestored' }), { capture: true })

  // ---------------------------------------------------------------- timers
  // at most once a second, for the idle signal
  let lastActive = 0
  const active = () => {
    const now = performance.now()
    if (now - lastActive < 1000) return
    lastActive = now
    push('timers', { event: 'activity' })
  }
  for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart']) on(window, type, active, { passive: true })
  on(document, 'visibilitychange', () => push('timers', { event: 'visibility', visible: document.visibilityState === 'visible' }))
  on(window, 'pageshow', (e: PageTransitionEvent) => e.persisted && push('timers', { event: 'resumed' }))
  on(window, 'online', () => push('timers', { event: 'resumed' }))
  let wake: WakeLockSentinel | null = null

  // ---------------------------------------------------------------- clipboard
  const items = async (data: DataTransfer | null) => {
    const out: Array<{ type: string; data: string | Uint8Array }> = []
    if (!data) return out
    for (const type of ['text/plain', 'text/html', 'text/uri-list']) {
      const text = data.getData(type)
      if (text) out.push({ type, data: text })
    }
    for (const f of [...data.files].slice(0, 8)) {
      if (f.type.startsWith('image/') && f.size < 16 * 1024 * 1024) out.push({ type: f.type, data: new Uint8Array(await f.arrayBuffer()) })
    }
    return out
  }
  on(document, 'paste', async (e: ClipboardEvent) => {
    const list = await items(e.clipboardData)
    if (list.length) push('clipboard', { event: 'host-write', items: list })
  })
  on(window, 'dragover', (e: DragEvent) => e.dataTransfer?.types.includes('Files') && e.preventDefault())
  on(window, 'drop', async (e: DragEvent) => {
    if (!e.dataTransfer?.files.length && !e.dataTransfer?.types.length) return
    e.preventDefault()
    push('clipboard', { event: 'host-drop', files: [...e.dataTransfer.files], items: await items(e.dataTransfer), position: { x: e.clientX, y: e.clientY } })
  })

  // ---------------------------------------------------------------- audio
  let ctx: SinkContext | null = null
  const nextStart = new Map<number, number>()
  let sinkId = ''
  const context = (): SinkContext => {
    if (ctx) return ctx
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    ctx = new C({ latencyHint: 'interactive' }) as SinkContext
    const tell = () => push('audio', { event: 'context', state: ctx!.state, baseLatency: ctx!.baseLatency, outputLatency: ctx!.outputLatency })
    ctx.addEventListener('statechange', tell)
    tell()
    if (sinkId) void ctx.setSinkId?.(sinkId).catch(() => {})
    return ctx
  }
  // the browser starts audio only after a gesture
  const unlock = () => {
    try {
      const c = context()
      if (c.state === 'suspended') void c.resume()
    } catch {
      // no Web Audio
    }
  }
  for (const type of ['pointerdown', 'keydown', 'touchend']) on(window, type, unlock, { capture: true })
  on(navigator.mediaDevices ?? window, 'devicechange', () => push('audio', { event: 'devices-changed' }))
  const mics = new Map<number, { stream: MediaStream; node: AudioWorkletNode; source: MediaStreamAudioSourceNode; ctx: AudioContext }>()

  const play = (d: { stream: number; sampleRate: number; channels: number; samples: Float32Array }) => {
    const c = context()
    const frames = d.samples.length / d.channels
    const buf = c.createBuffer(d.channels, frames, d.sampleRate)
    for (let ch = 0; ch < d.channels; ch++) {
      const data = buf.getChannelData(ch)
      for (let i = 0; i < frames; i++) data[i] = d.samples[i * d.channels + ch]!
    }
    const src = c.createBufferSource()
    src.buffer = buf
    src.connect(c.destination)
    const at = Math.max(nextStart.get(d.stream) ?? 0, c.currentTime + 0.03) // a little lead; a stream that fell behind restarts from now
    src.start(at)
    nextStart.set(d.stream, at + buf.duration)
  }

  const micWorklet = `registerProcessor('tiny-mic', class extends AudioWorkletProcessor {
    process(inputs) { const ch = inputs[0] && inputs[0][0]; if (ch) this.port.postMessage(ch.slice()); return true }
  })`

  // ---------------------------------------------------------------- system info
  const nav = navigator as Navigator & {
    deviceMemory?: number
    connection?: { effectiveType?: string; downlink?: number; saveData?: boolean; addEventListener?: (t: string, f: () => void) => void }
    getBattery?: () => Promise<{ level: number; charging: boolean; addEventListener: (t: string, f: () => void) => void }>
    gpu?: unknown
    userAgentData?: { platform?: string }
    keyboard?: { lock?: unknown }
  }
  const media = (q: string) => (typeof matchMedia === 'function' ? matchMedia(q) : null)
  const features = () =>
    Object.entries({
      webgl2: (() => { try { return Boolean(document.createElement('canvas').getContext('webgl2')) } catch { return false } })(),
      webgpu: Boolean(nav.gpu),
      sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined' && (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true,
      fileSystemAccess: 'showDirectoryPicker' in window,
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      keyboardLock: Boolean(nav.keyboard && 'lock' in nav.keyboard),
      opfs: Boolean(nav.storage && 'getDirectory' in nav.storage),
      wakeLock: 'wakeLock' in nav,
      battery: 'getBattery' in nav,
      webAudio: typeof AudioContext !== 'undefined',
      serviceWorker: 'serviceWorker' in nav,
      touch: nav.maxTouchPoints > 0,
    }).filter(([, on]) => on).map(([name]) => name)
  const sysHost = () => {
    let intl: { calendar?: string; numberingSystem?: string; hourCycle?: string } = {}
    try { intl = new Intl.DateTimeFormat().resolvedOptions() } catch { /* default */ }
    let locale: (Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } }) | null = null
    try { locale = new Intl.Locale(nav.language) } catch { /* default */ }
    const region = locale?.region ?? null
    const info = locale?.getWeekInfo?.() ?? locale?.weekInfo ?? null
    push('system', {
      event: 'host',
      hardware: {
        cores: nav.hardwareConcurrency ?? null, memoryHint: nav.deviceMemory ?? null, touch: nav.maxTouchPoints ?? 0,
        platform: nav.userAgentData?.platform ?? nav.platform, userAgent: nav.userAgent,
        screen: { width: screen.width, height: screen.height, scale: window.devicePixelRatio || 1 },
      },
      features: features(),
      languages: [...(nav.languages ?? [nav.language])],
      locale: { calendar: intl.calendar ?? null, numbering: intl.numberingSystem ?? null, hourCycle: intl.hourCycle ?? null, firstWeekday: info?.firstDay ?? null, measurement: region && ['US', 'LR', 'MM'].includes(region) ? 'us' : 'metric' },
      prefs: {
        reduceMotion: media('(prefers-reduced-motion: reduce)')?.matches ?? false,
        reduceTransparency: media('(prefers-reduced-transparency: reduce)')?.matches ?? false,
        highContrast: media('(prefers-contrast: more)')?.matches ?? false,
        colorScheme: media('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light',
      },
    })
  }
  sysHost()
  for (const q of ['(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(prefers-color-scheme: dark)']) {
    const mq = media(q)
    if (!mq) continue
    mq.addEventListener('change', sysHost)
    cleanups.push(() => mq.removeEventListener('change', sysHost))
  }
  on(window, 'languagechange', sysHost)
  const sendOnline = () => {
    const state = { event: 'online', online: navigator.onLine, connection: nav.connection ? { effectiveType: nav.connection.effectiveType, downlink: nav.connection.downlink, saveData: nav.connection.saveData } : null }
    push('system', state)
    push('network', state)
  }
  sendOnline()
  on(window, 'online', sendOnline)
  on(window, 'offline', sendOnline)
  nav.connection?.addEventListener?.('change', sendOnline)
  if (nav.getBattery) {
    nav.getBattery().then((b) => {
      const send = () => push('system', { event: 'battery', battery: { level: b.level, charging: b.charging } })
      send()
      b.addEventListener('levelchange', send)
      b.addEventListener('chargingchange', send)
    }, () => {})
  }
  try {
    const PO = (globalThis as unknown as { PressureObserver?: new (cb: (r: Array<{ state: string }>) => void) => { observe(s: string): Promise<void>; disconnect(): void } }).PressureObserver
    if (PO) {
      const po = new PO((records) => push('system', { event: 'pressure', state: records[records.length - 1]?.state }))
      void po.observe('cpu').catch(() => {})
      cleanups.push(() => po.disconnect())
    }
  } catch {
    // not available
  }

  // ---------------------------------------------------------------- session
  on(document, 'visibilitychange', () => push('session', { event: 'visibility', visible: document.visibilityState === 'visible' }))
  on(window, 'pagehide', () => push('session', { event: 'pagehide' }))
  on(window, 'online', () => push('session', { event: 'online', online: true }))
  on(window, 'offline', () => push('session', { event: 'online', online: false }))
  // A service worker that finished installing a newer build of the OS: Desktop shows "Restart to update".
  let waitingWorker: ServiceWorker | null = null
  if ('serviceWorker' in navigator) {
    const watchRegistration = (reg: ServiceWorkerRegistration) => {
      const ready = (w: ServiceWorker | null) => {
        if (!w || !navigator.serviceWorker.controller) return // first install: nothing to update
        waitingWorker = w
        push('session', { event: 'update', ready: true })
      }
      ready(reg.waiting)
      reg.addEventListener('updatefound', () => {
        const w = reg.installing
        w?.addEventListener('statechange', () => w.state === 'installed' && ready(w))
      })
    }
    void navigator.serviceWorker.getRegistration().then((reg) => reg && watchRegistration(reg)).catch(() => {})
  }

  // ---------------------------------------------------------------- what the services ask for
  /** `fetch` rejects with a bare TypeError; keep that from reading as "this browser lacks the feature". */
  const networkFailure = (e: unknown) => (e instanceof TypeError ? named('NetworkError', e.message || 'the request failed') : e)
  const streamsOut = new Map<number, AbortController>()
  const sockets = new Map<number, WebSocket>()
  const handlers: Record<string, (d: any) => Promise<unknown> | unknown> = {
    'clipboard.write': async (d) => {
      const types: Record<string, Blob> = {}
      for (const i of d.items as Array<{ type: string; data: string | Uint8Array }>) types[i.type] = new Blob([i.data as BlobPart], { type: i.type })
      if (!Object.keys(types).length) return
      await navigator.clipboard.write([new ClipboardItem(types)])
    },
    // ---- network: the services' sandbox has no network, so the page fetches for them
    'network.fetch': async (d) => {
      const ctl = new AbortController()
      const timer = setTimeout(() => ctl.abort(), d.timeout ?? 30_000)
      try {
        const res = await fetch(d.url, { ...d.init, signal: ctl.signal })
        const body = new Uint8Array(await res.arrayBuffer())
        if (body.length > 64 * 1024 * 1024) throw named('NotSupportedError', 'the response is too large')
        const headers: Record<string, string> = {}
        res.headers.forEach((v, k) => (headers[k] = v))
        return { status: res.status, statusText: res.statusText, headers, url: res.url, redirected: res.redirected, body }
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw named('TimeoutError', 'the request timed out')
        throw networkFailure(e)
      } finally {
        clearTimeout(timer)
      }
    },
    'network.stream': async (d) => {
      const ctl = new AbortController()
      streamsOut.set(d.stream, ctl)
      const res = await fetch(d.url, { ...d.init, signal: ctl.signal }).catch((e) => {
        streamsOut.delete(d.stream)
        throw networkFailure(e)
      })
      const total = Number(res.headers.get('content-length'))
      void (async () => {
        try {
          const reader = res.body?.getReader()
          for (;;) {
            const r = reader ? await reader.read() : { done: true as const, value: undefined }
            if (r.done) return push('network', { event: 'chunk', stream: d.stream, done: true })
            push('network', { event: 'chunk', stream: d.stream, data: r.value })
          }
        } catch (e) {
          push('network', { event: 'chunk', stream: d.stream, error: (e as Error).message })
        } finally {
          streamsOut.delete(d.stream)
        }
      })()
      return { status: res.status, statusText: res.statusText, total: total > 0 ? total : null }
    },
    'network.abort': (d) => void streamsOut.get(d.stream)?.abort(),
    'network.wsOpen': (d) =>
      new Promise((resolve, reject) => {
        const ws = new WebSocket(d.url, d.protocols)
        ws.binaryType = 'arraybuffer'
        sockets.set(d.socket, ws)
        ws.onopen = () => resolve({ protocol: ws.protocol })
        ws.onerror = () => {
          if (ws.readyState !== WebSocket.OPEN) {
            sockets.delete(d.socket)
            reject(named('NetworkError', 'the WebSocket could not connect'))
          } else push('network', { event: 'ws', socket: d.socket, kind: 'error' })
        }
        ws.onmessage = (ev) => push('network', { event: 'ws', socket: d.socket, kind: 'message', data: typeof ev.data === 'string' ? ev.data : new Uint8Array(ev.data as ArrayBuffer) })
        ws.onclose = (ev) => {
          sockets.delete(d.socket)
          push('network', { event: 'ws', socket: d.socket, kind: 'close', code: ev.code, reason: ev.reason })
        }
      }),
    'network.wsSend': (d) => void sockets.get(d.socket)?.send(d.data as string | Uint8Array<ArrayBuffer>),
    'network.wsClose': (d) => {
      const ws = sockets.get(d.socket)
      sockets.delete(d.socket)
      ws?.close(d.code === 1000 || (d.code >= 3000 && d.code < 5000) ? d.code : 1000)
    },
    // The page cannot close its tab or power anything off: it tells Desktop (`tiny:power`), which shows the screen.
    'session.power': (d) => void window.dispatchEvent(new CustomEvent('tiny:power', { detail: { action: d.action } })),
    'session.update': async (d) => {
      if (d.action === 'check') {
        const reg = await navigator.serviceWorker?.getRegistration()
        await reg?.update()
      } else if (waitingWorker) {
        navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true })
        waitingWorker.postMessage({ type: 'skip-waiting' })
      }
    },
    'input.keyboardLock': async (d) => {
      const kb = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } }).keyboard
      if (!kb) throw named('NotSupportedError', 'this browser has no Keyboard Lock')
      await kb.lock(d.keys)
    },
    'input.keyboardUnlock': () => void (navigator as Navigator & { keyboard?: { unlock(): void } }).keyboard?.unlock(),
    'system.storage': async () => {
      const est = await navigator.storage?.estimate?.()
      return { quota: est?.quota ?? null, usage: est?.usage ?? null, persisted: (await navigator.storage?.persisted?.()) ?? null }
    },
    'system.persist': async () => Boolean(await navigator.storage?.persist?.()),
    'timers.frame': () => void requestAnimationFrame((t) => push('timers', { event: 'frame', time: t })),
    'timers.idle': (d) => {
      const ric = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback
      if (ric) ric(() => push('timers', { event: 'idle', id: d.ref }), { timeout: 2000 })
      else setTimeout(() => push('timers', { event: 'idle', id: d.ref }), 50)
    },
    'timers.keepAwake': async (d) => {
      if (d.on) {
        if (wake && !wake.released) return
        wake = (await (navigator as { wakeLock?: { request(t: string): Promise<WakeLockSentinel> } }).wakeLock?.request('screen')) ?? null
      } else {
        await wake?.release()
        wake = null
      }
    },
    'input.pointerLock': async (d) => {
      if (d.on) await surface.requestPointerLock()
      else document.exitPointerLock()
      return d.on === Boolean(document.pointerLockElement)
    },
    'input.haptic': (d) => void navigator.vibrate?.(d.pattern),
    'input.announce': (d) => {
      let region = document.getElementById('tiny-announcer')
      if (!region) {
        region = document.createElement('div')
        region.id = 'tiny-announcer'
        region.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)'
        document.body.append(region)
      }
      region.setAttribute('aria-live', d.priority === 'assertive' ? 'assertive' : 'polite')
      region.textContent = ''
      setTimeout(() => (region!.textContent = d.text), 20) // a changed text is what screen readers announce
    },
    'display.fullscreen': async (d) => {
      if (d.on) await document.documentElement.requestFullscreen()
      else if (document.fullscreenElement) await document.exitFullscreen()
      return { fullscreen: Boolean(document.fullscreenElement) }
    },
    'display.cursor': (d) => void (surface.style.cursor = d.shape === 'default' ? '' : d.shape),
    'display.capture': async (d) => {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, preferCurrentTab: true } as DisplayMediaStreamOptions)
      try {
        const video = document.createElement('video')
        video.srcObject = stream
        video.muted = true
        await video.play()
        const r = d.region ?? { x: 0, y: 0, width: video.videoWidth, height: video.videoHeight }
        const canvas = new OffscreenCanvas(Math.max(1, Math.round(r.width)), Math.max(1, Math.round(r.height)))
        canvas.getContext('2d')!.drawImage(video, r.x, r.y, r.width, r.height, 0, 0, canvas.width, canvas.height)
        const png = await canvas.convertToBlob({ type: 'image/png' })
        return { type: 'image/png', width: canvas.width, height: canvas.height, data: new Uint8Array(await png.arrayBuffer()) }
      } finally {
        stream.getTracks().forEach((t) => t.stop())
      }
    },
    'audio.open': () => void unlock(),
    'audio.close': (d) => void nextStart.delete(d.stream),
    'audio.pcm': (d) => void play(d),
    'audio.mix': (d) => {
      sinkId = d.device ?? ''
      void ctx?.setSinkId?.(sinkId).catch(() => {})
    },
    'audio.sound': async (d) => {
      const c = context()
      const buf = await c.decodeAudioData((d.bytes as Uint8Array).slice().buffer)
      const src = c.createBufferSource()
      const gain = c.createGain()
      gain.gain.value = Number(d.gain ?? 1)
      src.buffer = buf
      src.connect(gain).connect(c.destination)
      src.start()
    },
    'audio.devices': async () => {
      const all = (await navigator.mediaDevices.enumerateDevices()).filter((x) => x.kind === 'audiooutput')
      return all.map((x) => ({ id: x.deviceId, label: x.label, kind: x.kind }))
    },
    'audio.setDevice': async (d) => {
      const c = context()
      if (!c.setSinkId) throw named('NotSupportedError', 'this browser cannot choose an output device')
      await c.setSinkId(d.id ?? '')
      sinkId = d.id ?? ''
    },
    'audio.micOpen': async (d) => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true } })
      const mctx = new AudioContext({ sampleRate: d.sampleRate })
      const url = URL.createObjectURL(new Blob([micWorklet], { type: 'text/javascript' }))
      try {
        await mctx.audioWorklet.addModule(url)
      } finally {
        URL.revokeObjectURL(url)
      }
      const source = mctx.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(mctx, 'tiny-mic')
      node.port.onmessage = (ev) => push('audio', { event: 'mic', stream: d.stream, samples: ev.data as Float32Array, sampleRate: mctx.sampleRate, channels: 1 })
      source.connect(node)
      mics.set(d.stream, { stream, node, source, ctx: mctx })
      return { sampleRate: mctx.sampleRate, channels: 1 }
    },
    'audio.micClose': (d) => {
      const m = mics.get(d.stream)
      if (!m) return
      mics.delete(d.stream)
      m.stream.getTracks().forEach((t) => t.stop())
      m.source.disconnect()
      void m.ctx.close()
    },
  }
  const off = kernel.onEvent((e) => {
    if (e.type !== 'driver') return
    const d = e.data as { op?: string; id?: number }
    const handler = d && typeof d.op === 'string' ? handlers[`${e.device}.${d.op}`] : undefined
    if (handler) answer(e.device, d.id, async () => handler(d))
    else if (d?.id !== undefined) reply(e.device, d.id, false, named('NotSupportedError', `the page has no ${e.device}.${d.op}`))
  })

  return () => {
    off()
    for (const c of cleanups.splice(0)) c()
    for (const m of mics.values()) m.stream.getTracks().forEach((t) => t.stop())
    for (const w of sockets.values()) w.close()
    for (const c of streamsOut.values()) c.abort()
    void wake?.release()
    void ctx?.close()
  }
}
