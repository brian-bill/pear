/** Pear event bus so modules do not import each other in circles. */
export type Topic = 'entries' | 'selection' | 'location' | 'sidebar' | 'chrome'
const subs = new Map<Topic, Set<() => void>>()

export const bus = {
  on(topic: Topic, fn: () => void): void {
    const set = subs.get(topic) ?? new Set()
    set.add(fn)
    subs.set(topic, set)
  },
  emit(topic: Topic): void {
    for (const fn of subs.get(topic) ?? []) fn()
  },
}
