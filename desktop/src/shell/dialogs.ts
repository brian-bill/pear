/// Sheets and panels the SDK's `tiny.dialogs` shows: alert, prompt, and the Open and Save panels.
/// They are drawn by Desktop, outside the app's sandbox, so the app only ever learns what the user chose.
import { ICONS, TYPE_ICONS } from '../apps/icons'
import type { Kernel } from '../../../vanilla/kernel/src/client'
import type { Win } from '../wm/windows'

/** The symbolic type name for an entry, cached by extension; Desktop asks launch services once. */
const panelKinds = new Map<string, Promise<string>>()
function panelKind(kernel: Kernel, full: string): Promise<string> {
  const dot = full.lastIndexOf('.')
  const key = dot > 0 ? full.slice(dot + 1).toLowerCase() : `~${full}`
  let p = panelKinds.get(key)
  if (!p) {
    p = kernel.launchIconFor(full).then((i) => (i.name === 'app' ? 'document' : i.name), () => 'file')
    panelKinds.set(key, p)
  }
  return p
}

export interface AlertOptions {
  title?: string
  message: string
  detail?: string
  buttons?: string[]
  defaultButton?: number
  cancelButton?: number
  danger?: boolean
}

export interface PanelOptions {
  title?: string
  startIn?: string
  button?: string
  filters?: Array<{ name: string; ext: string[] }>
  multiple?: boolean
  directory?: boolean
  name?: string
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = '') => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text) e.textContent = text
  return e
}

/** Show `build`'s content as a sheet over a window (or the whole screen when there is none). Resolves what `done` is given. */
export function sheet<T>(win: Win | null, build: (box: HTMLElement, done: (v: T) => void) => void | (() => void)): Promise<T> {
  return new Promise((resolve) => {
    const back = el('div', `sheet-backdrop${win ? '' : ' screen'}`)
    const box = el('div', 'sheet')
    box.setAttribute('role', 'dialog')
    box.setAttribute('aria-modal', 'true')
    back.append(box)
    let cleanup: void | (() => void)
    const done = (v: T) => {
      cleanup?.()
      back.remove()
      resolve(v)
    }
    // clicks behind the sheet go nowhere
    back.addEventListener('pointerdown', (e) => e.target === back && e.preventDefault())
    ;(win ? win.el : document.body).append(back)
    cleanup = build(box, done)
  })
}

export function alertSheet(win: Win | null, o: AlertOptions): Promise<number> {
  return sheet<number>(win, (box, done) => {
    box.append(el('h2', '', o.title ?? ''), el('p', '', o.message))
    if (!o.title) box.firstElementChild!.remove()
    if (o.detail) box.append(el('p', 'detail', o.detail))
    const row = el('div', 'buttons')
    const labels = o.buttons?.length ? o.buttons : ['OK']
    const def = o.defaultButton ?? 0
    // the default button sits at the right; buttons are given in the order the app lists them
    labels.forEach((label, i) => {
      const b = el('button', i === def ? (o.danger ? 'danger' : 'primary') : '', label)
      b.addEventListener('click', () => done(i))
      row.append(b)
    })
    row.append(...[...row.children].reverse())
    box.append(row)
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && o.cancelButton !== undefined) done(o.cancelButton)
      else if (e.key === 'Escape' && labels.length === 1) done(0)
    }
    document.addEventListener('keydown', key, true)
    ;(row.querySelector('.primary, .danger') as HTMLElement | null ?? (row.firstElementChild as HTMLElement)).focus()
    return () => document.removeEventListener('keydown', key, true)
  })
}

export function promptSheet(win: Win | null, o: { message: string; title?: string; value?: string; placeholder?: string; button?: string; select?: [number, number] }): Promise<string | null> {
  return sheet<string | null>(win, (box, done) => {
    if (o.title) box.append(el('h2', '', o.title))
    box.append(el('p', '', o.message))
    const input = el('input')
    input.type = 'text'
    input.value = o.value ?? ''
    input.placeholder = o.placeholder ?? ''
    box.append(input)
    const row = el('div', 'buttons')
    const cancel = el('button', '', 'Cancel')
    const ok = el('button', 'primary', o.button ?? 'OK')
    row.append(cancel, ok)
    box.append(row)
    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', () => done(input.value))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') done(input.value)
      else if (e.key === 'Escape') done(null)
    })
    input.focus()
    const [a, b] = o.select ?? [0, input.value.length]
    input.setSelectionRange(a, b)
  })
}

interface Entry {
  name: string
  dir: boolean
}

/**
 * The Open and Save panels. Desktop browses the file system itself (it is the system); the app gets paths and,
 * through `permPickerGrant`, the right to use exactly those.
 */
export function panel(kernel: Kernel, win: Win | null, mode: 'open' | 'save', o: PanelOptions, home: string): Promise<string[] | null> {
  return sheet<string[] | null>(win, (box, done) => {
    box.classList.add('picker')
    let cwd = o.startIn ?? `${home}/Documents`
    let entries: Entry[] = []
    let selected: string[] = []
    const filters = o.filters ?? []
    let filter = filters[0]

    const top = el('div', 'top')
    const up = el('button', '', '↑')
    up.title = 'Enclosing folder'
    up.setAttribute('aria-label', 'Enclosing folder')
    const pathInput = el('input')
    pathInput.type = 'text'
    pathInput.setAttribute('aria-label', 'Folder')
    top.append(up, pathInput)
    const nameRow = el('div', 'name-row')
    const nameInput = el('input')
    nameInput.type = 'text'
    nameInput.value = o.name ?? ''
    nameInput.setAttribute('aria-label', 'Name')
    if (mode === 'save') {
      nameRow.append(el('span', '', 'Save As:'), nameInput)
      box.append(nameRow)
    }
    const mid = el('div', 'mid')
    const side = el('div', 'side')
    const list = el('div', 'files')
    list.setAttribute('role', 'listbox')
    mid.append(side, list)
    const bottom = el('div', 'bottom')
    const hint = el('span', 'detail grow')
    const newFolder = el('button', '', 'New Folder')
    const cancel = el('button', '', 'Cancel')
    const ok = el('button', 'primary', o.button ?? (mode === 'save' ? 'Save' : 'Open'))
    const filterSel = el('select')
    for (const f of filters) filterSel.append(Object.assign(el('option', '', f.name), { value: f.name }))
    filterSel.addEventListener('change', () => ((filter = filters.find((f) => f.name === filterSel.value)), render()))
    bottom.append(hint)
    if (filters.length) bottom.append(filterSel)
    if (mode === 'save') bottom.append(newFolder)
    bottom.append(cancel, ok)
    if (o.title) box.prepend(Object.assign(el('h2', '', o.title), { style: 'padding:14px 14px 0' }))
    box.append(top, mid, bottom)
    // the title (if any) was prepended, top must come before mid: order is title, [save name], top, mid, bottom
    if (mode === 'save') box.insertBefore(nameRow, top)

    const join = (d: string, n: string) => (d === '/' ? `/${n}` : `${d}/${n}`)
    const places: Array<[string, string]> = [['Home', home], ['Desktop', `${home}/Desktop`], ['Documents', `${home}/Documents`], ['Downloads', `${home}/Downloads`], ['Applications', '/Applications']]
    const allowed = (n: string) => !filter || filter.ext.includes('*') || filter.ext.includes(n.slice(n.lastIndexOf('.') + 1).toLowerCase())

    const load = async (dir: string) => {
      try {
        const real = await kernel.realpath(dir)
        const list = await kernel.readdir(real)
        entries = list.map((e) => ({ name: e.name, dir: e.kind === 'dir' })).filter((e) => !e.name.startsWith('.')).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name))
        cwd = real
        selected = []
        pathInput.value = cwd
        render()
      } catch (e) {
        hint.textContent = `Cannot open ${dir}: ${(e as Error).message}`
      }
    }

    const render = () => {
      side.replaceChildren(
        ...places.map(([name, p]) => {
          const b = el('button', cwd === p ? 'cur' : '', name)
          b.addEventListener('click', () => void load(p))
          return b
        }),
      )
      list.replaceChildren(
        ...entries.map((e) => {
          const full = join(cwd, e.name)
          const bundle = e.name.endsWith('.app')
          const pickable = mode === 'open' ? (o.directory ? e.dir : !e.dir || bundle) : !e.dir
          const usable = e.dir ? true : allowed(e.name)
          const row = el('div', `entry${selected.includes(full) ? ' sel' : ''}${usable && (e.dir || pickable) ? '' : ' dim'}`)
          row.setAttribute('role', 'option')
          const slot = el('span', 'eslot')
          slot.innerHTML = e.dir ? ICONS.folder! : ICONS.file!
          row.append(slot, el('span', '', e.name))
          if (!e.dir)
            void panelKind(kernel, full).then((kind) => {
              if (row.isConnected && TYPE_ICONS[kind]) slot.innerHTML = TYPE_ICONS[kind]!
            })
          row.addEventListener('click', (ev) => {
            if (e.dir && !o.directory && !bundle) return void (selected = [], render())
            if (mode === 'open' && o.multiple && (ev.metaKey || ev.ctrlKey)) selected = selected.includes(full) ? selected.filter((s) => s !== full) : [...selected, full]
            else selected = [full]
            if (mode === 'save' && !e.dir) nameInput.value = e.name
            render()
          })
          row.addEventListener('dblclick', () => {
            if (e.dir && !(bundle && mode === 'open' && !o.directory)) void load(full)
            else if (pickable && usable) accept()
          })
          return row
        }),
      )
      hint.textContent = mode === 'open' ? (selected.length ? `${selected.length} selected` : o.directory ? 'Choose a folder' : 'Choose a file') : ''
      ok.disabled = mode === 'open' ? !(selected.length || (o.directory && cwd)) : !nameInput.value.trim()
    }

    const accept = () => {
      if (mode === 'save') {
        const n = nameInput.value.trim()
        if (n && !n.includes('/')) done([join(cwd, n)])
        return
      }
      if (selected.length) done(selected)
      else if (o.directory) done([cwd])
    }

    up.addEventListener('click', () => void load(cwd.slice(0, cwd.lastIndexOf('/')) || '/'))
    pathInput.addEventListener('keydown', (e) => e.key === 'Enter' && void load(pathInput.value))
    nameInput.addEventListener('input', render)
    nameInput.addEventListener('keydown', (e) => e.key === 'Enter' && accept())
    newFolder.addEventListener('click', async () => {
      const name = await promptSheet(win, { message: 'Name of the new folder', value: 'untitled folder', title: 'New Folder' })
      if (!name) return
      try {
        await kernel.mkdir(join(cwd, name))
        await load(cwd)
      } catch (e) {
        hint.textContent = (e as Error).message
      }
    })
    cancel.addEventListener('click', () => done(null))
    ok.addEventListener('click', accept)
    const key = (e: KeyboardEvent) => e.key === 'Escape' && done(null)
    document.addEventListener('keydown', key, true)
    void load(cwd)
    return () => document.removeEventListener('keydown', key, true)
  })
}
