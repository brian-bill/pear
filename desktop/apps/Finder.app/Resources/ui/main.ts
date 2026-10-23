import { tiny } from '@tiny/sdk'
import { goFolder, reveal, startPolling } from './browser'
import { bus } from './bus'
import { initChrome, renderChrome } from './chrome'
import { $, hasHostFiles } from './dom'
import { mountInfo } from './info'
import { initKeys } from './keys'
import { initMenus } from './menus'
import { dropHostFiles } from './ops'
import { initPreview } from './preview'
import { initSidebar } from './sidebar'
import { folderPath, st, type SavedState } from './state'
import { HOME } from './util'
import { initView, render } from './view'

async function start(): Promise<void> {
  await tiny.ready
  const saved = (tiny.app.state ?? {}) as SavedState
  if (saved.info) return mountInfo(saved.info)

  tiny.app.onSaveState(() => ({ path: folderPath(), view: st.view, sort: st.sort, hidden: st.showHidden }) satisfies SavedState)
  if (saved.view) st.view = saved.view
  if (saved.sort) st.sort = saved.sort
  st.showHidden = !!saved.hidden

  initView()
  initSidebar()
  initChrome()
  initPreview()
  initKeys()
  initMenus()
  bus.on('entries', renderChrome)

  // files dragged in from the real computer anywhere on the window land in the current folder
  document.addEventListener('dragover', (e) => hasHostFiles(e) && e.preventDefault())
  document.addEventListener('drop', (e) => {
    if (e.defaultPrevented || !hasHostFiles(e)) return
    e.preventDefault()
    if (st.loc.type === 'folder') void dropHostFiles(Array.from(e.dataTransfer!.files), st.loc.path)
  })

  tiny.on('reveal', (p) => void reveal(String(p)))
  tiny.app.onOpenFile((p) => void reveal(p))
  tiny.on('theme', () => render())

  const arg = tiny.app.args[0]
  await goFolder(saved.path ?? arg ?? HOME)
  startPolling()
  $('files').focus()
}

void start()
