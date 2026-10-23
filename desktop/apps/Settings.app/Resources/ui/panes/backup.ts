import { tiny } from '@tiny/sdk'
import { attempt, button, group, h, line, say } from '../lib'

const k = <T,>(m: string, ...a: unknown[]) => tiny.admin.kernel<T>(m, ...a)
const BACKUP = '/Users/pear/Documents/Pear backup.tinyimg'

/** Make a disk image and hand it to the user. The sandbox forbids `<a download>`, so the image is written to Documents and sent through `tiny.host.exportPath`. */
export async function createBackup(passphrase: string): Promise<string> {
  for (let tries = 0; ; tries++) {
    try {
      return await createBackupOnce(passphrase)
    } catch (e) {
      // Two interleaved kernel calls can trip wasm-bindgen's aliasing guard; the image is rebuilt from scratch, so one retry is safe.
      const flake = e instanceof Error && e.name === 'KernelError' && /unsafe aliasing/.test(e.message)
      if (tries > 0 || !flake) throw e
      await new Promise((r) => setTimeout(r, 250))
    }
  }
}

async function createBackupOnce(passphrase: string): Promise<string> {
  say('Creating the backup…')
  const blob = await k<Blob>('imageCreate', passphrase ? { passphrase } : {})
  await tiny.writeFile(BACKUP, new Uint8Array(await blob.arrayBuffer()))
  try {
    await tiny.host.exportPath(BACKUP, { saveAs: true })
    return 'Backup saved to Documents and downloaded.'
  } catch {
    return 'Backup saved to Documents as “Pear backup.tinyimg”.'
  }
}

export async function restoreBackup(): Promise<string | null> {
  const picked = await tiny.dialogs.openFile({ title: 'Choose a backup', filters: [{ name: 'Pear disk image', ext: ['tinyimg'] }] })
  if (!picked?.[0]) return null
  const file = new Blob([(await tiny.readFile(picked[0])) as BlobPart])
  let passphrase: string | undefined
  let info = await k<any>('imageVerify', file)
  if (info.encrypted && !info.ok) {
    const p = await tiny.dialogs.prompt('This backup is encrypted. Passphrase:', { title: 'Restore' })
    if (p === null) return null
    passphrase = p
    info = await k<any>('imageVerify', file, passphrase)
  }
  if (!info.ok) throw new Error(info.error ?? 'This is not a usable backup.')
  const when = info.created ? new Date(info.created).toLocaleString() : 'unknown date'
  if (!(await tiny.dialogs.confirm('Restore this backup?', { detail: `Made ${when}, ${info.entries} items. Files in the backup replace files with the same name; everything else stays.`, buttons: ['Restore', 'Cancel'] }))) return null
  const r = await k<any>('imageRestore', file, { mode: 'merge', passphrase })
  return `Restored ${r.files} files${Object.keys(r.skipped).length ? `, ${Object.keys(r.skipped).length} skipped` : ''}.`
}

export function backupSection(): HTMLElement {
  const pass = h('input', { type: 'password', 'aria-label': 'Backup passphrase', placeholder: 'Optional passphrase' })
  return group('Backup',
    line('Create a backup', h('span', { class: 'row' }, pass, button('Back Up Now', async () => {
      const msg = await attempt(() => createBackup(pass.value))
      if (msg) say(msg)
    })), 'A disk image of your files and settings. A passphrase encrypts it.'),
    line('Restore from a backup', button('Restore…', async () => {
      const msg = await attempt(restoreBackup)
      if (msg) say(msg)
    }), 'Merges the backup into the current files.'))
}
