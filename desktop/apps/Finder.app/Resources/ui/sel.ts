import { bus } from './bus'
import { st } from './state'

export function select(paths: string[], cursor = paths[paths.length - 1] ?? ''): void {
  st.selection = new Set(paths)
  st.cursor = cursor
  st.anchor = paths[0] ?? ''
  bus.emit('selection')
}

export function selectAll(): void {
  select(st.entries.map((e) => e.path), st.entries[0]?.path ?? '')
}
