import { tiny } from '@tiny/sdk'
import { attempt, button, group, h, line, say, sys, toggle } from '../lib'

/// App sources: the list of places apps can be installed from, and a way to add one.
/// Browsing, installing and updating live in the App Store. The `tiny.sources` service does the work; this is the view.

interface SourceRow {
  id: string
  name: string
  url: string
  host: string
  origin: 'native' | 'user'
  enabled: boolean
  keyFingerprint?: string
  status: { state: 'ok' | 'stale' | 'error' | 'unknown'; apps?: number; refreshed?: string; error?: { code: string; message: string } }
}
interface Preview {
  url: string
  host: string
  name: string
  description: string
  capabilities: string[]
  fingerprint: string | null
  signed: boolean
  apps: number | null
}
interface Installed { sourceId: string; version: string }
const svc = <T,>(msg: Record<string, unknown>) => sys<T>('tiny.sources', msg)

const ago = (iso?: string): string => {
  if (!iso) return ''
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000))
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`
}

function describe(s: SourceRow): string {
  const st = s.status
  const state = !s.enabled ? 'Off' : st.state === 'ok' ? `Online · ${st.apps ?? 0} apps · refreshed ${ago(st.refreshed)}`
    : st.state === 'stale' ? `Unreachable · showing the last copy${st.error ? ` (${st.error.message})` : ''}`
    : st.state === 'error' ? `Problem: ${st.error?.message ?? 'unknown'}` : 'Not checked yet'
  return `${s.host} · ${s.origin === 'native' ? 'Built-in' : 'Added by you'}${s.keyFingerprint ? ' · signed' : ''} · ${state}`
}

let openedWith = ''

/** The list of sources, with turn off, remove, refresh and add. `onChange` runs after the list changed. */
export async function sourcesSection(onChange: () => void, openWith?: string): Promise<HTMLElement> {
  const list = h('div', { class: 'group', id: 'sources' })
  const draw = async (refresh = false): Promise<void> => {
    if (refresh) await attempt(() => svc({ op: 'refresh' }))
    const rows = await svc<SourceRow[]>({ op: 'list' })
    list.replaceChildren(...(rows.length ? rows.map((s) => h('div', { class: 'line', 'data-source': s.id },
      h('div', { class: 'label' }, s.name, h('small', null, describe(s))),
      h('div', { class: 'ctl' },
        toggle(`Use ${s.name}`, s.enabled, async (on) => {
          await attempt(() => svc({ op: 'set', id: s.id, enabled: on }))
          await draw()
          onChange()
        }),
        s.origin === 'user' ? button('Remove', async () => {
          if (!(await tiny.dialogs.confirm(`Remove ${s.name}?`, { detail: 'Apps already installed from it stay installed, but will not get updates from it.', danger: true, buttons: ['Remove', 'Cancel'] }))) return
          if ((await attempt(() => svc({ op: 'remove', id: s.id }), `${s.name} was removed.`)) === undefined) return
          await draw()
          onChange()
        }, 'danger', { 'aria-label': `Remove ${s.name}` }) : null))) : [line('No sources. Add one to find apps.')]))
  }
  await draw()
  const add = async (given?: string): Promise<void> => {
    const address = given ?? (await tiny.dialogs.prompt('Address of the source', { title: 'Add Source' }))
    if (!address?.trim()) return
    const p = await attempt(() => svc<Preview>({ op: 'preview', url: address }))
    if (!p) return
    const detail = [
      p.description,
      `Address: ${p.host}`,
      p.signed ? `Signed. Key fingerprint: ${p.fingerprint!.slice(0, 16)}…` : 'Not signed: you are trusting the address only.',
      p.apps !== null ? `${p.apps} apps listed.` : null,
      '',
      'Apps from this source can ask for permissions. You review each app before it installs.',
    ].filter((x) => x !== null).join('\n')
    if (!(await tiny.dialogs.confirm(`Add “${p.name}” as a source?`, { detail, buttons: ['Add Source', 'Cancel'] }))) return
    if ((await attempt(() => svc({ op: 'add', url: address, fingerprint: p.fingerprint ?? '' }), `${p.name} was added.`)) === undefined) return
    await draw()
    onChange()
  }
  const section = h('section', { id: 'app-sources' }, h('h2', null, 'App sources'), list,
    h('div', { class: 'line' }, h('div', { class: 'label' }, h('small', null, 'Anyone can run a source on their own domain. Pear adds none by itself beyond the built-in ones.')),
      h('div', { class: 'ctl' }, button('Refresh', async () => { await draw(true); say('Sources refreshed.') }), button('Add Source…', () => add()))))
  // a link that offered this source (`?addSource=`) opens the same review, with the address filled in; nothing is added until confirmed
  if (openWith && openedWith !== openWith) {
    openedWith = openWith // the pane is drawn again when it is shown; the link is asked about once
    void add(openWith)
  }
  return section
}

/** Browsing, installing and updating live in the App Store; this is the pointer to it. */
export function storeSection(): HTMLElement {
  return h('section', { id: 'get-apps' }, h('h2', null, 'Get apps and updates'),
    group(null, h('div', { class: 'line' },
      h('div', { class: 'label' }, 'Find apps, developer tools and runtimes, and install updates, in the App Store.', h('small', null, 'It uses the sources below. Each app is reviewed before it installs.')),
      h('div', { class: 'ctl' }, button('Open App Store', () => tiny.shell.openApp('org.tiny.appstore'))))))
}

/** `appId -> source name`, for the installed list. */
export async function provenanceNames(): Promise<Record<string, string>> {
  try {
    const [installed, sources] = await Promise.all([svc<Record<string, Installed>>({ op: 'provenance' }), svc<SourceRow[]>({ op: 'list' })])
    return Object.fromEntries(Object.entries(installed).map(([id, i]) => [id, sources.find((s) => s.id === i.sourceId)?.name ?? i.sourceId]))
  } catch {
    return {}
  }
}
