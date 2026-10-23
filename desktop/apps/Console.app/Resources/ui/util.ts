import { escapeHtml } from '@tiny/sdk'

export const esc = escapeHtml
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const p2 = (n: number) => String(n).padStart(2, '0')
export function clock(t: number, ms = true): string {
  const d = new Date(t)
  return `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}${ms ? `.${String(d.getMilliseconds()).padStart(3, '0')}` : ''}`
}
export const dateTime = (t: number) => `${new Date(t).toLocaleDateString()} ${clock(t)}`

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', html = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (html) e.innerHTML = html
  return e
}

/** Copy text. The window has no clipboard permission, so fall back to the old selection trick, which needs none. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const t = Object.assign(document.createElement('textarea'), { value: text })
    t.style.cssText = 'position:fixed;opacity:0;left:-999px'
    document.body.append(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}
