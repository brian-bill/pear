import { textOf, tiny } from '@tiny/sdk'

export type Field = HTMLTextAreaElement | HTMLInputElement

/** Replace the selection through the browser's edit command, so undo and redo keep working. */
export function insert(field: Field, text: string): void {
  field.focus()
  if (!document.execCommand('insertText', false, text)) field.setRangeText(text, field.selectionStart ?? 0, field.selectionEnd ?? 0, 'end')
}

/** Replace [from, to) and leave the caret (or the new text selected). */
export function replaceRange(ta: HTMLTextAreaElement, from: number, to: number, text: string, select = false): void {
  ta.focus()
  ta.setSelectionRange(from, to)
  insert(ta, text)
  if (select) ta.setSelectionRange(from, from + text.length)
}

/** Tab inserts spaces; with a multi-line selection it indents the lines, Shift+Tab outdents them. */
export function tab(ta: HTMLTextAreaElement, back: boolean, width = 4): void {
  const v = ta.value
  const a = ta.selectionStart
  const b = ta.selectionEnd
  const multi = v.slice(a, b).includes('\n')
  if (!back && !multi) {
    const col = a - (v.lastIndexOf('\n', a - 1) + 1)
    insert(ta, ' '.repeat(width - (col % width)))
    return
  }
  const from = v.lastIndexOf('\n', a - 1) + 1
  let to = v.indexOf('\n', b > a && v[b - 1] === '\n' ? b - 1 : b)
  if (to < 0) to = v.length
  const lines = v.slice(from, to).split('\n')
  const out = lines.map((l) => (back ? l.replace(new RegExp(`^(\\t| {1,${width}})`), '') : l ? ' '.repeat(width) + l : l))
  replaceRange(ta, from, to, out.join('\n'), true)
}

/** Enter keeps the indentation of the line it breaks. */
export function enter(ta: HTMLTextAreaElement): void {
  const v = ta.value
  const from = v.lastIndexOf('\n', ta.selectionStart - 1) + 1
  const indent = /^[ \t]*/.exec(v.slice(from, ta.selectionStart))![0]
  insert(ta, `\n${indent}`)
}

const TEXT = 'public.utf8-plain-text'
type Reply = { items?: Array<{ data: unknown }> }

/** Pasteboard access through the system clipboard service. */
export const clip = {
  async write(text: string): Promise<void> {
    await tiny.service('tiny.clipboard', { op: 'write', items: [{ type: TEXT, data: text }] })
  },
  async read(): Promise<string | null> {
    const r = (await tiny.service<Reply>('tiny.clipboard', { op: 'read', types: [TEXT] }))
    const data = r?.items?.[0]?.data
    return typeof data === 'string' ? data : data instanceof Uint8Array ? textOf(data) : null
  },
}
