import { WINDOW_POINTS } from './spark'

/** The last two minutes of the numbers we chart. Filled by every refresh, whichever tab is showing. */
export const history = {
  heap: [] as number[],
  procs: [] as number[],
  push(heap: number | null, procs: number): void {
    if (heap !== null) this.heap.push(heap)
    this.procs.push(procs)
    for (const a of [this.heap, this.procs]) while (a.length > WINDOW_POINTS) a.shift()
  },
}
