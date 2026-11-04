import { formatBytes, joinPath, tiny } from '@tiny/sdk'

interface Check { id: string; ok: boolean; severity: 'error' | 'warning'; message: string }
interface Report {
  ok: boolean
  checks: Check[]
  manifest: { id: string; name: string; version: string } | null
  files: number
  bytes: number
  packageBytes: number
}


const mark = (c: Check): string => (c.ok ? '✓' : c.severity === 'error' ? '✗' : '⚠')

/** A project with a window and no process of its own gets the standard one, as Pear's own apps do when they are built. */
const options = async () => ({ extra: { 'main.js': await tiny.host.runtime() } })

export const report = async (project: string): Promise<Report> => (await tiny.bundleCheck(project, await options())) as Report

const lines = (checks: Check[]): string => checks.map((c) => `${mark(c)} ${c.message}`).join('\n')

/** Show the checks. Returns true if packaging can go ahead (errors stop it; warnings are shown and left to the person). */
async function review(project: string, title: string, extra: Check[] = [], proceed?: string): Promise<Report | null> {
  const r = await report(project)
  const checks = [...r.checks, ...(r.ok ? extra : [])]
  const warned = checks.some((c) => !c.ok)
  if (!r.ok) {
    await tiny.dialogs.alert({ title, message: 'This project can’t be packaged yet.', detail: lines(checks), buttons: ['OK'] })
    return null
  }
  if (!proceed) {
    await tiny.dialogs.alert({ title, message: `${r.manifest!.name} ${r.manifest!.version} is ready to share.`, detail: lines(checks), buttons: ['OK'] })
    return r
  }
  if (!warned) return r
  const choice = await tiny.dialogs.alert({ title, message: 'A few things to look at first.', detail: lines(checks), buttons: [proceed, 'Cancel'], cancelButton: 1 })
  return choice === 0 ? r : null
}

async function writePackage(project: string, r: Report): Promise<string> {
  const bytes = await tiny.bundlePackage(project, await options())
  const home = (await tiny.getenv('HOME')) || '/Users/pear'
  const clean = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, '-')
  const path = joinPath(joinPath(home, 'Downloads'), `${clean(r.manifest!.name)}-${clean(r.manifest!.version)}.pearapp`)
  await tiny.writeFileAtomic(path, bytes)
  return path
}

const failed = (what: string, e: unknown) => tiny.dialogs.alert({ title: what, message: (e as Error).message || 'Something went wrong.', buttons: ['OK'] })

/** Share ▸ Check Project… */
export async function checkProject(project: string): Promise<void> {
  try {
    await review(project, 'Check Project')
  } catch (e) {
    await failed('Check Project', e)
  }
}

/** Share ▸ Package & Install: the package goes to Downloads and opens in the App Installer. */
export async function packageAndInstall(project: string): Promise<void> {
  try {
    const r = await review(project, 'Package & Install', [], 'Package')
    if (!r) return
    await tiny.shell.open(await writePackage(project, r))
  } catch (e) {
    await failed('Package & Install', e)
  }
}

/** Share ▸ Download .pearapp */
export async function downloadPackage(project: string): Promise<void> {
  try {
    const r = await review(project, 'Download .pearapp', [], 'Download')
    if (!r) return
    await tiny.host.exportPath(await writePackage(project, r), { saveAs: true })
  } catch (e) {
    await failed('Download .pearapp', e)
  }
}