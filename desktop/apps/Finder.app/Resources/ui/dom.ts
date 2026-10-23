export const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

export const isTyping = (t: EventTarget | null): boolean => t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement

export function debounce<A extends unknown[]>(ms: number, fn: (...a: A) => void): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined
  return (...a) => {
    clearTimeout(t)
    t = setTimeout(() => fn(...a), ms)
  }
}

/** Paths being dragged inside Finder. */
export const PATHS_TYPE = 'application/x-tiny-paths'

export function dragPaths(ev: DragEvent): string[] {
  try {
    return JSON.parse(ev.dataTransfer?.getData(PATHS_TYPE) || '[]') as string[]
  } catch {
    return []
  }
}
export const hasPaths = (ev: DragEvent) => Array.from(ev.dataTransfer?.types ?? []).includes(PATHS_TYPE)
export const hasHostFiles = (ev: DragEvent) => Array.from(ev.dataTransfer?.types ?? []).includes('Files')
