/// Installs the shell and core utilities (built from `userland/`) into the VFS.
import type { Kernel } from './client'

/** Where programs are installed. The default PATH starts with it. */
export const BIN = '/bin'

/**
 * Writes every program in `userland.json` to `/bin/<name>` (overwriting). This is what first-run setup
 * does until the boot sequence exists. `manifestUrl` defaults to `userland.json` next to this script.
 */
export async function installUserland(
  kernel: Pick<Kernel, 'mkdir' | 'writeFile' | 'chmod'>,
  manifestUrl: string | URL = new URL('userland.json', import.meta.url),
): Promise<string[]> {
  const res = await fetch(manifestUrl)
  if (!res.ok) throw new Error(`cannot load userland: ${res.status}`)
  const programs = (await res.json()) as Record<string, string>
  const enc = new TextEncoder()
  await kernel.mkdir(BIN, { recursive: true })
  for (const [name, source] of Object.entries(programs)) {
    await kernel.writeFile(`${BIN}/${name}`, enc.encode(source))
    await kernel.chmod(`${BIN}/${name}`, 0o755)
  }
  return Object.keys(programs).sort()
}
