import { basename, formatBytes, tiny } from '@tiny/sdk'

/// The one place an app is reviewed before it installs: a package opened from a file,
/// a link (`?install=`), or Code's "Package & Install". The kernel has already checked the checksum and every file's
/// hash by the time this shows anything; what is left for the person is whether they trust it and what it can reach.

interface Manifest {
  id: string
  name: string
  version: string
  permissions: string[]
  documentTypes?: Array<{ ext: string[] }>
  urlSchemes?: string[]
  kind?: string
  provides?: { name?: string; framework?: string; version?: string; api?: string; abi?: string[]; commands?: string[]; shebangs?: string[]; handles?: Array<{ ext: string[]; uti?: string }> }
  requires?: Array<{ runtime?: string; framework?: string; range: string }>
  commands?: Array<{ name: string; summary?: string }>
  autostart?: boolean
  service?: { name: string; restart: string; restartDelayMs?: number; maxRestarts?: number }
}
interface Unmet { kind: 'runtime' | 'framework'; name: string; range: string; reason: string }
interface InstalledRuntime { bundleId: string; name: string; commands: string[] }
/** What the review needs to know about the rest of the system. */
interface Context {
  unmet: Unmet[]
  clashes: Array<{ command: string; holder: string }>
  /** Commands of a bundle that another bundle or a runtime already holds (the person may take them over after the install). */
  taken: Array<{ name: string; holder: string }>
  /** Commands that would hide a program of the same name further along PATH. */
  shadows: Array<{ name: string; from: string }>
}
interface Archive {
  ok: boolean
  error?: string
  size: number
  digest: string
  manifest?: Manifest
  files: number
  bytes: number
  created?: string
  generator?: string
}
interface Review {
  /** Where it came from, as shown. */
  from: string
  manifest: Manifest
  files: number
  bytes: number
  /** What was checked, in words. */
  verified: string
  installed: { version: string } | null
  install(update: boolean): Promise<{ id: string; name: string }>
}

const kernel = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)
const view = document.getElementById('view')!
let token = 0

const WHAT: Record<string, string> = {
  'fs.container': 'Keep its own files',
  'fs.user': 'Read and change your files in Documents, Downloads, Desktop and other folders of yours',
  'fs.picker': 'Open files you choose',
  'fs.all': 'Read and change every file on this computer',
  clipboard: 'Use the clipboard',
  notifications: 'Show notifications',
  'audio.input': 'Use the microphone',
  'video.input': 'Use the camera',
  network: 'Connect to the internet',
  location: 'Know your location',
  'process.spawn': 'Start other programs',
  'display.capture': 'Record the screen',
  loopback: 'Run a web server that only this device can reach',
}
const SEVERE = new Set(['fs.all', 'process.spawn', 'display.capture'])

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null, ...kids: Array<Node | string | null | false>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v === undefined || v === null || v === false) continue
    if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener)
    else if (k === 'class') e.className = String(v)
    else e.setAttribute(k, v === true ? '' : String(v))
  }
  for (const c of kids) if (c) e.append(c)
  return e
}

const compare = (a: string, b: string): number => {
  const pa = a.split(/[-+]/)[0]!.split('.').map(Number)
  const pb = b.split(/[-+]/)[0]!.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0) ? -1 : 1
  return 0
}

function show(...nodes: Array<Node | null>): void {
  view.replaceChildren(...(nodes.filter(Boolean) as Node[]))
}

const busy = (msg: string) => show(el('div', { class: 'center' }, el('p', null, msg)))
const problem = (title: string, detail: string) =>
  show(el('div', { class: 'center' }, el('h1', null, title), el('p', { class: 'error', role: 'alert' }, detail), el('div', { class: 'actions' }, el('button', { onclick: () => tiny.window.close() }, 'Close'))))

async function installedVersion(id: string): Promise<{ version: string } | null> {
  try {
    return await kernel<{ version: string }>('bundleInfo', id)
  } catch {
    return null
  }
}

/** Requirements nothing installed meets, and commands a runtime wants that another one already holds. Never blocks the install. */
async function contextFor(m: Manifest): Promise<Context> {
  const unmet = m.requires?.length ? await kernel<Unmet[]>('runtimeUnmet', m.requires).catch(() => [] as Unmet[]) : []
  let clashes: Context['clashes'] = []
  if (m.kind === 'runtime' && m.provides?.commands?.length) {
    const have = await kernel<InstalledRuntime[]>('runtimeList').catch(() => [] as InstalledRuntime[])
    clashes = m.provides.commands.flatMap((command) => {
      const holder = have.find((x) => x.bundleId !== m.id && x.commands.includes(command))
      return holder ? [{ command, holder: holder.name }] : []
    })
  }
  let taken: Context['taken'] = []
  let shadows: Context['shadows'] = []
  if (m.commands?.length) {
    taken = (await kernel<Array<{ name: string; holder: string }>>('commandConflictsFor', m).catch(() => [])).map((c) => ({ name: c.name, holder: c.holder }))
    const held = new Set(taken.map((c) => c.name))
    for (const c of m.commands) {
      if (held.has(c.name)) continue
      const lower = await kernel<{ bundleName: string; bundleId: string } | null>('commandResolve', c.name).catch(() => null)
      if (lower && lower.bundleId !== m.id) shadows.push({ name: c.name, from: lower.bundleName })
    }
  }
  return { unmet, clashes, taken, shadows }
}

const RESTART: Record<string, string> = { never: 'never restarts', 'on-failure': 'restarts if it fails', always: 'restarts whenever it stops' }

function commandsCard(m: Manifest, ctx: Context, takeOver: HTMLInputElement | null): Node[] {
  const cmds = m.commands ?? []
  return [
    cmds.length ? el('div', { class: 'card', id: 'commands-card' }, el('h2', null, 'Commands it adds'),
      el('ul', null, ...cmds.map((c) => el('li', null, c.name, c.summary ? ` — ${c.summary}` : ''))),
      ctx.shadows.length ? el('p', { class: 'note', id: 'commands-shadow' }, `Also provided further along the command path: ${ctx.shadows.map((s) => `“${s.name}” (${s.from})`).join(', ')}. This app's version comes first.`) : null) : null,
    ctx.taken.length ? el('div', { class: 'card', id: 'commands-conflicts' }, el('h2', null, 'Commands already taken'),
      el('ul', null, ...ctx.taken.map((c) => el('li', { class: 'error' }, `“${c.name}” belongs to ${c.holder}. It keeps the command unless you take it over.`))),
      takeOver ? el('label', null, takeOver, ' Take over conflicting commands') : null) : null,
    m.service ? el('div', { class: 'card', id: 'service-card' }, el('h2', null, 'Runs in the background'),
      el('p', { class: 'note' }, `Service ${m.service.name}: ${m.autostart ? 'starts when Pear starts' : 'does not start by itself'}, ${RESTART[m.service.restart] ?? m.service.restart}.`)) : null,
  ].filter(Boolean) as Node[]
}

function runtimeCard(m: Manifest, ctx: Context): Node[] {
  const p = m.provides ?? {}
  const files = [...new Set((p.handles ?? []).flatMap((h) => (h.ext.length ? h.ext.map((e) => `.${e}`) : h.uti ? [h.uti] : [])))]
  return [
    el('div', { class: 'card', id: 'runtime-card' }, el('h2', null, 'This is a runtime'),
      el('p', { class: 'note' }, `It lets Pear run programs written for ${p.name ?? 'another language'}. It is not an app you open.`),
      el('dl', { class: 'facts' },
        el('dt', null, 'Runtime'), el('dd', null, `${p.name ?? m.name} ${p.version ?? ''}`.trim()),
        el('dt', null, 'Commands it adds'), el('dd', null, p.commands?.length ? p.commands.join(', ') : 'None'),
        el('dt', null, 'Shebangs'), el('dd', null, p.shebangs?.length ? p.shebangs.map((s) => `#!/usr/bin/env ${s}`).join(', ') : 'None'),
        el('dt', null, 'File types it opens'), el('dd', null, files.length ? files.join(', ') : 'None'),
        el('dt', null, 'abi'), el('dd', null, (p.abi ?? ['program']).join(', ')),
        el('dt', null, 'Can use (advisory)'), el('dd', null, m.permissions.length ? m.permissions.map((x) => WHAT[x] ?? x).join('; ') : 'No special access'))),
    ctx.clashes.length ? el('div', { class: 'card', id: 'runtime-conflicts' }, el('h2', null, 'Commands already taken'),
      el('ul', null, ...ctx.clashes.map((c) => el('li', { class: 'error' }, `“${c.command}” already belongs to ${c.holder}. It keeps the command; this runtime will not get it.`)))) : null,
    el('p', { class: 'note', id: 'runtime-trust' }, 'A runtime runs inside every app that uses it, with that app’s rights. Only add runtimes you trust.'),
  ].filter(Boolean) as Node[]
}

function review(r: Review, ctx: Context = { unmet: [], clashes: [], taken: [], shadows: [] }): void {
  const m = r.manifest
  const isRuntime = m.kind === 'runtime'
  const isFramework = m.kind === 'framework'
  const update = Boolean(r.installed)
  const downgrade = r.installed ? compare(m.version, r.installed.version) < 0 : false
  const reach: Array<[string, boolean]> = [
    ...m.permissions.map((p) => [WHAT[p] ?? p, SEVERE.has(p)] as [string, boolean]),
    ...((m.documentTypes ?? []).flatMap((d) => d.ext).length ? [[`Open ${[...new Set((m.documentTypes ?? []).flatMap((d) => d.ext))].map((e) => `.${e}`).join(', ')} files`, false] as [string, boolean]] : []),
    ...(m.urlSchemes ?? []).map((s) => [`Open ${s}: links`, false] as [string, boolean]),
  ]
  const go = el('button', { class: 'primary', id: 'go' }, update ? (downgrade ? 'Replace with Older Version' : 'Update') : 'Install')
  const takeOver = ctx.taken.length ? el('input', { type: 'checkbox', id: 'take-over' }) : null
  const cancel = el('button', { onclick: () => tiny.window.close() }, 'Cancel')
  go.addEventListener('click', async () => {
    go.setAttribute('disabled', '')
    cancel.setAttribute('disabled', '')
    busy(`${update ? 'Updating' : 'Installing'} ${m.name}…`)
    try {
      const app = await r.install(update)
      let note: string | null = null
      if (takeOver?.checked) {
        const failed: string[] = []
        for (const c of ctx.taken) await kernel('commandTakeOver', c.name, m.id).catch(() => void failed.push(c.name))
        if (failed.length) note = `Could not take over: ${failed.join(', ')}.`
      }
      done(app.id, app.name, update, m.kind, note)
    } catch (e) {
      const err = e as { code?: string; message?: string }
      problem(`${m.name} was not installed`, `${err.message ?? 'Something went wrong.'}${err.code ? ` (${err.code})` : ''}`)
    }
  })
  show(
    el('div', { class: 'head' }, el('div', { class: 'tile', 'aria-hidden': 'true' }, m.name.slice(0, 1).toUpperCase()),
      el('div', null, el('h1', null, m.name), el('small', null, `Version ${m.version} · ${m.id}`))),
    el('div', null,
      el('span', { class: 'badge warn' }, 'No verified publisher'), ' ',
      el('span', { class: 'badge ok' }, 'Contents verified')),
    el('dl', { class: 'facts' },
      el('dt', null, 'From'), el('dd', null, r.from),
      el('dt', null, 'Size'), el('dd', null, `${formatBytes(r.bytes)} in ${r.files} file${r.files === 1 ? '' : 's'}`),
      el('dt', null, 'Checked'), el('dd', null, r.verified),
      r.installed ? el('dt', null, 'On this computer') : null, r.installed ? el('dd', null, `Version ${r.installed.version}${downgrade ? ' (newer than this package)' : ''}`) : null),
    ...(isRuntime ? runtimeCard(m, ctx) : []),
    isFramework ? el('div', { class: 'card', id: 'framework-card' }, el('h2', null, 'This is a framework'),
      el('p', { class: 'note' }, 'A library that runtimes and apps share. It is not an app you open.'),
      el('dl', { class: 'facts' },
        el('dt', null, 'Framework'), el('dd', null, `${m.provides?.framework ?? m.name} ${m.provides?.version ?? ''}`.trim()),
        el('dt', null, 'api'), el('dd', null, m.provides?.api ?? 'Not stated'))) : null,
    ctx.unmet.length ? el('div', { class: 'card', id: 'unmet' }, el('h2', null, 'Needs something that is not installed'),
      el('ul', null, ...ctx.unmet.map((u) => el('li', { class: 'error' }, `${u.kind === 'runtime' ? 'Runtime' : 'Framework'} ${u.name} ${u.range}: ${u.reason}`))),
      el('p', { class: 'note' }, 'Install it first, then this app will run. You can still install this one now.')) : null,
    ...commandsCard(m, ctx, takeOver),
    isRuntime ? null : el('div', { class: 'card' }, el('h2', null, isFramework ? 'It can' : 'This app can'),
      reach.length ? el('ul', null, ...reach.map(([text, severe]) => el('li', severe ? { class: 'error' } : null, text))) : el('p', { class: 'note' }, 'Ask for no special access.')),
    isRuntime ? null : el('p', { class: 'note' }, 'It runs inside Pear’s sandbox and asks again for anything it needs later. Only install apps from people you trust.'),
    el('div', { class: 'spacer' }),
    el('div', { class: 'actions' }, cancel, go),
  )
  go.focus()
}

function done(id: string, name: string, updated: boolean, kind = 'app', note: string | null = null): void {
  const openable = !['runtime', 'framework', 'tool', 'service'].includes(kind)
  show(
    el('div', { class: 'center' }, el('div', { class: 'tile', style: 'margin:0 auto 12px' }, '✓'),
      el('h1', null, `${name} was ${updated ? 'updated' : 'installed'}`),
      note ? el('p', { class: 'error', role: 'alert' }, note) : null,
      el('p', { class: 'note' }, openable ? 'You can find it in the Launchpad.' : kind === 'runtime' ? 'Its commands are ready. See it in Settings > Runtimes.' : kind === 'tool' || kind === 'service' ? 'Its commands are ready to run in the Terminal.' : 'Apps and runtimes that need it can use it now.'),
      el('div', { class: 'actions', style: 'justify-content:center' },
        el('button', { onclick: () => tiny.window.close() }, 'Done'),
        openable ? el('button', { class: 'primary', id: 'open', onclick: () => void tiny.shell.openApp(id).then(() => tiny.window.close()) }, 'Open') : null)),
  )
}

// ---- sources

async function fromFile(path: string): Promise<Review> {
  const blob = new Blob([(await tiny.readFile(path)) as BlobPart])
  const info = await kernel<Archive>('bundleInspectArchive', blob)
  if (!info.ok || !info.manifest) throw Object.assign(new Error(info.error ?? 'This is not a Pear app package.'), { code: 'EINVAL' })
  return archiveReview(blob, info, basename(path), { kind: 'archive' })
}

function archiveReview(blob: Blob, info: Archive, from: string, source: { kind: 'archive' | 'url'; url?: string }): Promise<Review> {
  const manifest = info.manifest!
  return installedVersion(manifest.id).then((installed) => ({
    from,
    manifest,
    files: info.files,
    bytes: info.bytes,
    verified: 'The package is intact and every file matches its hash.',
    installed,
    install: async (update) => {
      const app = await kernel<{ id: string; name: string }>('bundleInstallArchive', blob, { update, expectDigest: info.digest, from: source.kind === 'url' ? { kind: 'url', url: source.url } : { kind: 'archive' } })
      return app
    },
  }))
}

async function fromUrl(url: string): Promise<Review> {
  const got = await tiny.admin.service<{ kind: 'archive'; url: string; bytes: Uint8Array; digest: string } | { kind: 'directory'; url: string; files: Record<string, Uint8Array>; manifestDigest: string }>('tiny.installer', { op: 'fetch', url })
  const host = new URL(got.url).host
  if (got.kind === 'archive') {
    const blob = new Blob([got.bytes as BlobPart])
    const info = await kernel<Archive>('bundleInspectArchive', blob)
    if (!info.ok || !info.manifest) throw Object.assign(new Error(info.error ?? 'This is not a Pear app package.'), { code: 'EINVAL' })
    return archiveReview(blob, info, got.url, { kind: 'url', url: got.url })
  }
  const manifest = JSON.parse(new TextDecoder().decode(got.files['manifest.json']!)) as Manifest & { name: string }
  const list = Object.values(got.files)
  return {
    from: `${got.url} (${host}, a folder of files rather than a package)`,
    manifest: { ...manifest, permissions: manifest.permissions ?? [] },
    files: list.length,
    bytes: list.reduce((n, f) => n + f.length, 0),
    verified: 'Each file matches the hash in its manifest.',
    installed: await installedVersion(manifest.id),
    install: async (update) => {
      const from = { kind: 'url', url: got.url, digest: got.manifestDigest, unsigned: true }
      const app = update ? await kernel<{ id: string; name: string }>('bundleUpdate', manifest.id, { files: got.files }, { from }) : await kernel<{ id: string; name: string }>('bundleInstall', { files: got.files }, { from })
      return app
    },
  }
}

async function route(arg: string): Promise<void> {
  const mine = ++token
  busy('Checking the package…')
  try {
    const r = arg.startsWith('install:') ? await fromUrl(arg.slice('install:'.length)) : await fromFile(arg)
    const ctx = await contextFor(r.manifest)
    if (mine === token) review(r, ctx)
  } catch (e) {
    const err = e as { code?: string; message?: string }
    if (mine === token) problem('This can’t be installed', `${err.message ?? 'Something went wrong.'}${err.code ? ` (${err.code})` : ''}`)
  }
}

tiny.app.onOpenFile((arg) => void route(arg))
tiny.app.onOpenURL((url) => void route(`install:${url}`))
void (async () => {
  await tiny.ready
  const first = tiny.app.args.find((a) => a.startsWith('install:') || a.startsWith('/'))
  if (first) void route(first)
  else show(el('div', { class: 'center' }, el('h1', null, 'App Installer'), el('p', { class: 'note' }, 'Open a .pearapp file, or follow an install link, to add an app.')))
})()
