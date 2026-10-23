import { tiny, escapeHtml, basename, dirname, joinPath } from '@tiny/sdk'
import { $ } from './dom'
import { fillIcon } from './icons'
import { alertError, cap, dateText, errText, extOf, isAppName, parseTags, readTags, sizeText, TAG_COLORS, TAG_HEX, writeTags } from './util'

const USERS: Record<number, string> = { 0: 'root', 501: 'tiny' }
const GROUPS: Record<number, string> = { 0: 'wheel', 20: 'staff' }
const who = (m: Record<number, string>, id: number) => m[id] ?? String(id)

async function folderSize(path: string, budget = { n: 20000 }): Promise<{ bytes: number; items: number }> {
  let bytes = 0
  let items = 0
  for (const e of await tiny.readdir(path).catch(() => [])) {
    if (budget.n-- <= 0) break
    const p = joinPath(path, e.name)
    items++
    if (e.kind === 'dir') {
      const s = await folderSize(p, budget)
      bytes += s.bytes
      items += s.items
    } else bytes += (await tiny.lstat(p).catch(() => null))?.size ?? 0
  }
  return { bytes, items }
}

const BITS = [
  ['Owner', 6],
  ['Group', 3],
  ['Others', 0],
] as const
const PERMS = [['Read', 4], ['Write', 2], ['Execute', 1]] as const

export async function mountInfo(initial: string): Promise<void> {
  let path = initial
  document.body.classList.add('info-mode')
  void tiny.window.resize(420, 600).catch(() => {})
  void tiny.window.setMenus([{ title: 'Finder', items: [{ label: 'About Finder', action: () => void tiny.dialogs.alert({ message: 'Finder' }) }] }])
  const root = $('info')

  async function draw(): Promise<void> {
    let s
    try {
      s = await tiny.stat(path)
    } catch (e) {
      root.innerHTML = `<p class="dim">“${escapeHtml(basename(path))}” is not available. ${escapeHtml(errText(e))}</p>`
      return
    }
    const name = basename(path) || 'Macintosh HD'
    const isApp = s.kind === 'dir' && isAppName(name)
    const isDir = s.kind === 'dir' && !isApp
    const type = await tiny.launchTypeOf(path).catch(() => null)
    const tags = await readTags(path)
    void tiny.window.setTitle(`${name} Info`)
    const perm = BITS.map(([label, shift]) => `<tr><th scope="row">${label}</th>${PERMS.map(([p, bit]) => `<td><label><input type="checkbox" data-shift="${shift}" data-bit="${bit}" aria-label="${label} ${p}" ${(s.mode >> shift) & bit ? 'checked' : ''}> ${p}</label></td>`).join('')}</tr>`).join('')
    root.innerHTML = `
      <header class="ihead"><img class="thumb big" alt=""><div class="grow"><input id="i-name" type="text" value="${escapeHtml(name)}" aria-label="Name" spellcheck="false"><div class="dim" id="i-sub">${escapeHtml(type?.description ?? '')}</div></div></header>
      <section aria-label="General"><h3>General</h3><dl>
        <dt>Kind</dt><dd>${escapeHtml(isApp ? 'Application' : type?.description ?? s.kind)}</dd>
        <dt>Size</dt><dd id="i-size">${isDir ? 'Calculating…' : sizeText(s.size)}</dd>
        <dt>Where</dt><dd class="selectable">${escapeHtml(dirname(path))}</dd>
        <dt>Created</dt><dd>${dateText(s.birthtime)}</dd>
        <dt>Modified</dt><dd>${dateText(s.mtime)}</dd>
      </dl></section>
      <section aria-label="Tags"><h3>Tags</h3><div class="chips">${TAG_COLORS.map((t) => `<button class="chip" data-tag="${t}" aria-pressed="${tags.includes(t)}" aria-label="${cap(t)}"><i style="background:${TAG_HEX[t]}"></i>${cap(t)}</button>`).join('')}</div>
        <input id="i-tags" type="text" value="${escapeHtml(tags.join(', '))}" placeholder="Add tags, separated by commas" aria-label="Tags"></section>
      ${isDir || isApp ? '' : '<section aria-label="Open with"><h3>Open with</h3><select id="i-open" aria-label="Open with"></select></section>'}
      <section aria-label="Sharing and permissions"><h3>Sharing &amp; Permissions</h3>
        <dl><dt>Owner</dt><dd>${who(USERS, s.uid)}</dd><dt>Group</dt><dd>${who(GROUPS, s.gid)}</dd><dt>Mode</dt><dd id="i-mode">${(s.mode & 0o777).toString(8).padStart(3, '0')}</dd></dl>
        <table class="perms">${perm}</table></section>`
    const img = root.querySelector<HTMLImageElement>('img.thumb')!
    fillIcon(img, { path, name, isApp, isDir })
    if (isDir) void folderSize(path).then((r) => ($('i-size').textContent = `${sizeText(r.bytes)} (${r.items} ${r.items === 1 ? 'item' : 'items'})`))

    const nameInput = $<HTMLInputElement>('i-name')
    nameInput.addEventListener('keydown', async (ev) => {
      if (ev.key !== 'Enter') return
      const next = nameInput.value.trim()
      if (!next || next === name) return
      const to = joinPath(dirname(path), next)
      try {
        if (next.includes('/') || (await tiny.exists(to))) throw new Error('That name is not available.')
        await tiny.rename(path, to)
        path = to
      } catch (e) {
        await alertError(`“${name}” cannot be renamed.`, e)
      }
      void draw()
    })
    root.querySelectorAll<HTMLElement>('[data-tag]').forEach((b) =>
      b.addEventListener('click', async () => {
        const cur = await readTags(path)
        const t = b.dataset.tag!
        await writeTags(path, cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t])
        void draw()
      }),
    )
    $('i-tags').addEventListener('change', async (ev) => {
      await writeTags(path, parseTags((ev.target as HTMLInputElement).value.toLowerCase()))
      void draw()
    })
    root.querySelectorAll<HTMLInputElement>('input[data-bit]').forEach((c) =>
      c.addEventListener('change', async () => {
        let mode = s.mode & 0o7777
        const bit = Number(c.dataset.bit) << Number(c.dataset.shift)
        mode = c.checked ? mode | bit : mode & ~bit
        try {
          await tiny.chmod(path, mode)
        } catch (e) {
          await alertError('The permissions cannot be changed.', e)
        }
        void draw()
      }),
    )
    const sel = document.getElementById('i-open') as HTMLSelectElement | null
    if (sel && type) {
      const apps = await tiny.launchAppsFor(path).catch(() => [])
      const def = await tiny.launchDefaultFor(type.uti).catch(() => null)
      sel.innerHTML = apps.length ? apps.map((a) => `<option value="${escapeHtml(a.id)}" ${a.id === def?.id ? 'selected' : ''}>${escapeHtml(a.name)}${a.id === def?.id ? ' (default)' : ''}</option>`).join('') : '<option>No application available</option>'
      sel.disabled = !apps.length
      sel.addEventListener('change', async () => {
        try {
          await tiny.launchSetDefault(extOf(name) ? type.uti : type.uti, sel.value)
        } catch (e) {
          await alertError('The default application cannot be changed.', e)
        }
      })
    }
  }
  await draw()
}
