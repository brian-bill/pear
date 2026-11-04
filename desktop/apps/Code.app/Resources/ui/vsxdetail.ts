// The extension details page, opened in the editor area as a tab (like VS Code): header with the
// install / enable / uninstall actions, then Details (README), Features (what it contributes) and
// Changelog. Remote images are fetched through the proxy and shown from blob URLs, because the
// window's CSP only allows data: and blob: images.
import { escapeHtml, tiny } from '@tiny/sdk'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { icon } from './icons'
import { extId, type Listing } from './vsx'
import { readExtText, type Installed } from './vsxstore'

const blobs = new Map<string, Promise<string | null>>()

/** An https image as a blob URL (cached), or null. */
export function iconUrl(url: string | undefined): Promise<string | null> {
  if (!url || !/^https:\/\//i.test(url)) return Promise.resolve(null)
  let p = blobs.get(url)
  if (!p) {
    p = tiny.net
      .fetch(url, { timeout: 15_000 })
      .then(async (r) => (r.ok ? URL.createObjectURL(new Blob([await r.arrayBuffer()], { type: r.headers.get('content-type') ?? 'image/png' })) : null))
      .catch(() => null)
    blobs.set(url, p)
  }
  return p
}

export interface DetailActions {
  install(l: Listing): void
  uninstall(e: Installed): void
  setEnabled(e: Installed, on: boolean): void
  installing(id: string): boolean
  /** 'node' when the extension cannot run in a browser; undefined while that is being checked. */
  runnable(id: string): 'web' | 'node' | 'unknown' | undefined
  nodeOnly: string
}

export interface DetailSource {
  id: string
  installed: Installed | undefined
  listing: Listing | undefined
}

const first = async (ext: Installed, names: string[]): Promise<string | null> => {
  for (const n of names) {
    try {
      return await readExtText(ext, n)
    } catch {
      /* try the next spelling */
    }
  }
  return null
}

async function remoteText(url: string | undefined): Promise<string | null> {
  if (!url) return null
  try {
    const r = await tiny.net.fetch(url, { timeout: 20_000 })
    return r.ok ? await r.text() : null
  } catch {
    return null
  }
}

/** Markdown as safe HTML in `into`, with images fetched through the proxy and links opened in the browser. */
async function markdownInto(into: HTMLElement, text: string, base?: string): Promise<void> {
  into.classList.add('markdown')
  into.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }) as string)
  for (const a of into.querySelectorAll('a')) {
    const href = a.getAttribute('href') ?? ''
    a.addEventListener('click', (e) => {
      e.preventDefault()
      const target = base && !/^[a-z]+:/i.test(href) ? new URL(href, base).href : href
      if (/^https?:\/\//i.test(target)) void tiny.shell.open(target)
    })
  }
  for (const img of [...into.querySelectorAll('img')].slice(0, 24)) {
    const src = img.getAttribute('src') ?? ''
    img.removeAttribute('src')
    const abs = base && !/^[a-z]+:/i.test(src) ? new URL(src, base).href : src
    void iconUrl(abs).then((u) => (u ? img.setAttribute('src', u) : img.replaceWith(Object.assign(document.createElement('span'), { textContent: img.alt ? `[${img.alt}]` : '' }))))
  }
}

function contributions(ext: Installed | undefined, listing: Listing | undefined): string {
  const c = ext?.manifest.contributes
  if (!c) return `<p class="vsxmuted">${listing ? 'Install the extension to see what it contributes.' : 'This extension contributes nothing declarative.'}</p>`
  const out: string[] = []
  const section = (title: string, rows: string[]): void => void (rows.length && out.push(`<h3>${escapeHtml(title)} (${rows.length})</h3><ul>${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`))
  section('Commands', (c.commands ?? []).map((x) => `<code>${escapeHtml(x.command)}</code> — ${escapeHtml(x.title)}`))
  section('Color Themes', (c.themes ?? []).map((x) => escapeHtml(x.label)))
  section('Snippets', (c.snippets ?? []).map((x) => `${escapeHtml(x.language ?? 'all languages')} <span class="vsxmuted">${escapeHtml(x.path)}</span>`))
  section('Languages', (c.languages ?? []).map((x) => `${escapeHtml(x.id)} <span class="vsxmuted">${escapeHtml((x.extensions ?? []).join(', '))}</span>`))
  section('Grammars', (c.grammars ?? []).map((x) => `${escapeHtml(x.scopeName)} <span class="vsxmuted">(not applied in Code yet)</span>`))
  const known = new Set(['commands', 'themes', 'snippets', 'languages', 'grammars'])
  const other = Object.keys(c).filter((k) => !known.has(k))
  if (other.length) out.push(`<h3>Other contribution points</h3><p class="vsxmuted">${escapeHtml(other.join(', '))} (not supported in Code)</p>`)
  return out.join('') || '<p class="vsxmuted">This extension contributes nothing declarative.</p>'
}

const fmt = (iso?: string): string => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—')

export function renderDetail(root: HTMLElement, src: DetailSource, actions: DetailActions): void {
  const ext = src.installed
  const l = src.listing
  const m = ext?.manifest
  const name = m?.displayName ?? l?.displayName ?? src.id
  const publisher = m?.publisher ?? l?.namespace ?? ''
  const version = ext?.version ?? l?.version ?? ''
  const desc = m?.description ?? l?.description ?? ''
  root.replaceChildren()
  const page = document.createElement('div')
  page.className = 'vsxpage'

  const head = document.createElement('div')
  head.className = 'vsxhead'
  const art = document.createElement('div')
  art.className = 'vsxart'
  art.innerHTML = icon('extensions', 64)
  void iconUrl(l?.iconUrl).then((u) => u && (art.innerHTML = `<img src="${u}" alt="" width="128" height="128">`))
  const info = document.createElement('div')
  info.className = 'vsxinfo'
  const stats = [
    `<span>${escapeHtml(publisher)}${l?.verified ? ' <span class="vsxverified" title="Verified publisher">✓</span>' : ''}</span>`,
    l ? `<span>${l.downloads.toLocaleString()} downloads</span>` : '',
    l?.rating ? `<span>★ ${l.rating.toFixed(1)}${l.reviews ? ` (${l.reviews})` : ''}</span>` : '',
    version ? `<span>v${escapeHtml(version)}</span>` : '',
  ].filter(Boolean)
  info.innerHTML = `<h1>${escapeHtml(name)}${ext ? '' : ''}</h1><div class="vsxstats">${stats.join('')}</div><p>${escapeHtml(desc)}</p>`
  const buttons = document.createElement('div')
  buttons.className = 'vsxactions'
  const add = (label: string, fn: () => void, secondary = false): void => {
    const b = document.createElement('button')
    b.className = secondary ? 'vsxbtn secondary' : 'vsxbtn'
    b.style.marginLeft = '0'
    b.textContent = label
    b.addEventListener('click', fn)
    buttons.append(b)
  }
  let nodeNote = ''
  if (ext) {
    add(ext.enabled ? 'Disable' : 'Enable', () => actions.setEnabled(ext, !ext.enabled), true)
    add('Uninstall', () => actions.uninstall(ext), true)
  } else if (l) {
    add(actions.installing(l.id) ? 'Installing…' : 'Install', () => actions.install(l))
    const b = buttons.lastElementChild as HTMLButtonElement
    const state = actions.runnable(l.id)
    if (state === 'node') {
      b.disabled = true
      b.classList.add('unavailable')
      b.title = actions.nodeOnly
      nodeNote = actions.nodeOnly
    } else if (actions.installing(l.id) || !state) b.disabled = true
  }
  info.append(buttons)
  if (nodeNote) info.append(Object.assign(document.createElement('div'), { className: 'vsxmuted', textContent: nodeNote }))
  if (ext) {
    const tag = document.createElement('div')
    tag.className = 'vsxmuted'
    tag.textContent = `${ext.signed ? 'From Open VSX' : `${ext.source.kind === 'folder' ? 'Local folder' : 'VSIX'} · unsigned`}${ext.enabled ? '' : ' · disabled'}`
    info.append(tag)
  }
  head.append(art, info)

  const tabs = document.createElement('div')
  tabs.className = 'vsxtabs'
  const body = document.createElement('div')
  body.className = 'vsxbody'
  const main = document.createElement('div')
  main.className = 'vsxmain'
  const side = document.createElement('aside')
  side.className = 'vsxside'
  const categories = l?.categories ?? []
  const link = (label: string, url?: string): string => (url ? `<li><a href="${escapeHtml(url)}" class="vsxlink">${escapeHtml(label)}</a></li>` : '')
  side.innerHTML = `
    ${categories.length ? `<h4>Categories</h4><p>${categories.map((c) => `<span class="tag">${escapeHtml(c)}</span>`).join(' ')}</p>` : ''}
    <h4>Resources</h4><ul>${link('Repository', l?.repository) || '<li class="vsxmuted">—</li>'}${l?.license ? `<li>License: ${escapeHtml(l.license)}</li>` : ''}</ul>
    <h4>More Info</h4><dl>
      <dt>Published</dt><dd>${escapeHtml(fmt(l?.published))}</dd>
      <dt>Identifier</dt><dd>${escapeHtml(extId({ publisher, name: m?.name ?? l?.name ?? src.id.split('.').slice(1).join('.') }))}</dd>
      <dt>Version</dt><dd>${escapeHtml(version)}</dd>
    </dl>`
  for (const a of side.querySelectorAll<HTMLAnchorElement>('a.vsxlink')) a.addEventListener('click', (e) => (e.preventDefault(), void tiny.shell.open(a.getAttribute('href')!)))

  const loaders: Record<string, () => Promise<void>> = {
    Details: async () => {
      main.textContent = 'Loading…'
      const text = (ext && (await first(ext, ['README.md', 'readme.md', 'Readme.md', 'README.markdown']))) ?? (await remoteText(l?.readmeUrl))
      if (text === null || text === undefined) return void (main.innerHTML = `<p class="vsxmuted">This extension has no README.</p>`)
      await markdownInto(main, text, l?.readmeUrl)
    },
    Features: async () => void (main.innerHTML = contributions(ext, l)),
    Changelog: async () => {
      main.textContent = 'Loading…'
      const text = (ext && (await first(ext, ['CHANGELOG.md', 'changelog.md', 'Changelog.md']))) ?? (await remoteText(l?.changelogUrl))
      if (!text) return void (main.innerHTML = `<p class="vsxmuted">This extension has no changelog.</p>`)
      await markdownInto(main, text, l?.changelogUrl)
    },
  }
  const select = (which: string): void => {
    for (const b of tabs.querySelectorAll('button')) b.setAttribute('aria-selected', String(b.textContent === which))
    main.className = 'vsxmain'
    void loaders[which]!()
  }
  for (const label of Object.keys(loaders)) {
    const b = document.createElement('button')
    b.textContent = label
    b.addEventListener('click', () => select(label))
    tabs.append(b)
  }
  body.append(main, side)
  page.append(head, tabs, body)
  root.append(page)
  select('Details')
}
