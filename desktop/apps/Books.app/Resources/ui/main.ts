import { tiny } from '@tiny/sdk'
import { runLibrary } from './library'
import { runReader } from './reader'

/** A Books window is either the library or a reader for one book, told by how it was opened:
 *  - `app.state.path` — opened from the library (or restored from a session), so a reader.
 *  - `app.args[0]` — a file was opened with Books directly (Finder, `open … -a`), so a reader.
 *  - otherwise — a plain launch: the library.
 * All windows share the UI page; the two modes are separate divs. */
async function main(): Promise<void> {
  await tiny.ready
  const state = tiny.app.state as { path?: unknown } | null | undefined
  const fromState = typeof state?.path === 'string' && state.path ? state.path : null
  const fromArgs = typeof tiny.app.args[0] === 'string' && tiny.app.args[0] ? tiny.app.args[0] : null
  const path = fromState ?? fromArgs
  if (path) {
    document.getElementById('library')?.remove()
    runReader(path)
  } else {
    document.getElementById('reader')?.remove()
    runLibrary()
  }
}

void main()
