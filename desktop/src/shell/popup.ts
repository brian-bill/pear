/// Pop-up menus: the menu bar's dropdowns and context menus share this.
import type { MenuItem } from './menubar'

export interface PopupHandle {
  el: HTMLElement
  close(): void
}

let current: PopupHandle | null = null

/** Close whatever pop-up is showing. */
export function closePopup(): void {
  current?.close()
}

/** Show a menu with its top-left at (x, y), kept inside the screen. `onClose` runs once however it ends. */
export function showPopup(items: MenuItem[], at: { x: number; y: number }, onClose?: () => void): PopupHandle {
  closePopup()
  const el = document.createElement('div')
  el.className = 'menu'
  el.setAttribute('role', 'menu')
  let done = false
  const close = () => {
    if (done) return
    done = true
    el.remove()
    document.removeEventListener('pointerdown', away, true)
    document.removeEventListener('keydown', key, true)
    if (current === handle) current = null
    onClose?.()
  }
  const handle: PopupHandle = { el, close }
  for (const item of items) {
    if (item.separator) {
      el.append(document.createElement('hr'))
      continue
    }
    const b = document.createElement('button')
    b.setAttribute('role', item.checked !== undefined ? 'menuitemcheckbox' : 'menuitem')
    if (item.checked !== undefined) b.setAttribute('aria-checked', String(item.checked))
    b.disabled = Boolean(item.disabled)
    b.innerHTML = '<span class="check"></span><span class="label"></span><span class="shortcut"></span>'
    b.querySelector('.check')!.textContent = item.checked ? '✓' : ''
    b.querySelector('.label')!.textContent = item.label ?? ''
    b.querySelector('.shortcut')!.textContent = item.shortcut ?? ''
    b.addEventListener('click', () => {
      close()
      item.action?.()
    })
    el.append(b)
  }
  const away = (e: Event) => {
    const t = e.target as HTMLElement
    if (!el.contains(t) && !t.closest?.('.menubar .title')) close()
  }
  const key = (e: KeyboardEvent) => {
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') close()
    else if (e.key === 'ArrowDown') buttons[(at + 1) % buttons.length]?.focus()
    else if (e.key === 'ArrowUp') buttons[(at - 1 + buttons.length) % buttons.length]?.focus()
    else return
    e.preventDefault()
    e.stopPropagation()
  }
  document.body.append(el)
  el.style.left = `${Math.max(4, Math.min(at.x, innerWidth - el.offsetWidth - 4))}px`
  el.style.top = `${Math.max(4, Math.min(at.y, innerHeight - el.offsetHeight - 4))}px`
  // listen after this event finishes, or the click that opened the menu would close it
  setTimeout(() => {
    if (done) return
    document.addEventListener('pointerdown', away, true)
    document.addEventListener('keydown', key, true)
  })
  current = handle
  return handle
}
