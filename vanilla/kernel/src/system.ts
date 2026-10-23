/// The boot sequence after the kernel itself is up: create the default hierarchy on first run, install the
/// userland and the system services, read settings, start the services, and report what happened.
import { APPS, OS_VERSION, SYSTEM_APPS, type BundleManager } from './bundle'
import type { Config } from './config'
import type { Logger } from './log'
import type { FileSystem } from './fs'
import type { LaunchServices } from './launch'
import type { Permissions } from './perm'
import type { ProcessTable } from './process'
import { DEFAULT_GROUPS, DEFAULT_USERS, groupText, passwdText, ROOT_UID, type UserDb } from './users'

export interface SystemOptions {
  /** `userland.json` (program name -> source) for `/bin`. `false` skips it. Default: next to the kernel Worker. */
  userland?: string | URL | false
  /** `services.json` (service name -> source). `false` skips the services. Default: next to the kernel Worker. */
  services?: string | URL | false
  /**
   * Start only what the system needs: no startup items, no third-party services, no session restore. The page
   * decides (a held key, a `?safe` URL, or after repeated crashes).
   */
  safeMode?: boolean
  /**
   * The page saw the last session end in an orderly way (`pagehide` fired, as when a tab is closed or reloaded), so a
   * leftover session marker is not a crash. Only a power cut or a killed browser leaves one that counts.
   */
  lastExitClean?: boolean
}

export interface BootInfo {
  /** The hierarchy was created during this boot. */
  firstBoot: boolean
  /** When this boot started (ms since the epoch). */
  bootTime: number
  version: string
  /** The last session ended without `shutdown`. */
  previousShutdown: 'clean' | 'crash'
  /** This boot skipped startup items, third-party services and session restore. */
  safeMode: boolean
  /** Named ports of the services that came up. */
  services: string[]
  /** Things that could not be done (a missing `userland.json`, say). */
  warnings: string[]
}

export type SystemEvent = { type: 'system'; event: 'progress'; stage: string; fraction: number }

/** Marks a session in progress: present at boot means the last one was not shut down. */
export const SESSION_MARK = '/var/db/.session'
const RELEASE_FILE = '/etc/pear-release'
/** How the last session ended (`clean` or `crash`), for the session service. */
const PREVIOUS_FILE = '/var/db/.previous'
const SAFE_FILE = '/var/db/.safemode'

/** The system services, as bundles in `/System/Applications`. `port` is the name each registers. */
const SERVICES = [
  { file: 'launch', id: 'org.tiny.service.launch', name: 'Launch Service', port: 'tiny.launch' },
  { file: 'settings', id: 'org.tiny.service.settings', name: 'Settings Service', port: 'tiny.settings' },
  { file: 'notifications', id: 'org.tiny.service.notifications', name: 'Notification Service', port: 'tiny.notifications' },
  { file: 'registry', id: 'org.tiny.service.registry', name: 'App Registry', port: 'tiny.registry' },
  { file: 'clipboard', id: 'org.tiny.driver.clipboard', name: 'Clipboard Driver', port: 'tiny.clipboard' },
  { file: 'timers', id: 'org.tiny.driver.timers', name: 'Timer Driver', port: 'tiny.timers' },
  { file: 'input', id: 'org.tiny.driver.input', name: 'Input Driver', port: 'tiny.input' },
  { file: 'display', id: 'org.tiny.driver.display', name: 'Display Driver', port: 'tiny.display' },
  { file: 'audio', id: 'org.tiny.driver.audio', name: 'Audio Driver', port: 'tiny.audio' },
  { file: 'search', id: 'org.tiny.service.search', name: 'Search Service', port: 'tiny.search' },
  { file: 'session', id: 'org.tiny.service.session', name: 'Session Service', port: 'tiny.session' },
  { file: 'network', id: 'org.tiny.service.network', name: 'Network Service', port: 'tiny.network' },
  { file: 'system', id: 'org.tiny.service.system', name: 'System Info Service', port: 'tiny.system' },
] as const

interface Dir {
  path: string
  mode: number
  /** `user` is the person using the machine; the rest belong to root. */
  owner?: 'user'
}

const hierarchy = (home: string): Dir[] => [
  { path: '/System', mode: 0o755 },
  { path: SYSTEM_APPS, mode: 0o755 },
  { path: '/System/Library', mode: 0o755 },
  { path: APPS, mode: 0o755 },
  { path: '/bin', mode: 0o755 },
  { path: '/usr', mode: 0o755 },
  { path: '/etc', mode: 0o755 },
  { path: '/dev', mode: 0o755 },
  { path: '/var', mode: 0o755 },
  { path: '/var/log', mode: 0o755 },
  { path: '/var/db', mode: 0o755 },
  { path: '/var/root', mode: 0o700 },
  { path: '/tmp', mode: 0o1777 },
  { path: '/Users', mode: 0o755 },
  { path: home, mode: 0o755, owner: 'user' },
  ...['Desktop', 'Documents', 'Downloads', 'Library', 'Library/Preferences', 'Library/Containers', 'Library/Application Support', 'Applications', '.Trash'].map(
    (d): Dir => ({ path: `${home}/${d}`, mode: d === 'Library' || d === '.Trash' ? 0o700 : 0o755, owner: 'user' }),
  ),
]

const enc = new TextEncoder()
const dec = new TextDecoder()

interface SystemParts {
  fs: FileSystem
  users: UserDb
  config: Config
  bundles: BundleManager
  perms: Permissions
  launch: LaunchServices
  procs: ProcessTable
  logger?: Logger
}

async function fetchJson(url: string | URL, warnings: string[], what: string): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return (await res.json()) as Record<string, string>
  } catch (e) {
    warnings.push(`${what} not installed: ${(e as Error).message}`)
    return null
  }
}

/** Write a file owned by root if its content differs. Returns whether it wrote. */
async function install(fs: FileSystem, path: string, text: string, mode: number): Promise<boolean> {
  const data = enc.encode(text)
  try {
    if (dec.decode(await fs.readFile(path)) === text) return false
  } catch {
    // missing
  }
  await fs.writeFileAtomic(path, data)
  await fs.chmod(path, mode)
  return true
}

export async function bootSystem(parts: SystemParts, opts: SystemOptions, emit: (e: SystemEvent) => void): Promise<BootInfo> {
  const { fs, users, bundles, launch, procs } = parts
  const { logger } = parts
  const progress = (stage: string, fraction: number) => {
    logger?.mark(`boot: ${stage}`)
    emit({ type: 'system', event: 'progress', stage, fraction })
  }
  const warnings: string[] = []
  const bootTime = Date.now()

  // 1. The hierarchy, on first run.
  progress('file system', 0.1)
  const firstBoot = !(await fs.exists('/etc/passwd'))
  const crashed = (await fs.exists(SESSION_MARK)) && !opts.lastExitClean
  if (firstBoot) {
    const user = DEFAULT_USERS.find((u) => u.uid !== ROOT_UID)!
    for (const d of hierarchy(user.home)) {
      await fs.as(d.owner ? user.uid : 0, d.owner ? user.gid : 0, () => fs.mkdir(d.path, { recursive: true }))
      await fs.chmod(d.path, d.mode)
    }
    await fs.writeFile('/etc/passwd', enc.encode(passwdText(DEFAULT_USERS)))
    await fs.writeFile('/etc/group', enc.encode(groupText(DEFAULT_GROUPS)))
    for (const f of ['/etc/passwd', '/etc/group']) await fs.chmod(f, 0o644)
  }
  await fs.writeFile(RELEASE_FILE, enc.encode(`Pear ${OS_VERSION}\n`))
  await fs.writeFile(SESSION_MARK, enc.encode(`${bootTime}\n`))
  await fs.writeFile(PREVIOUS_FILE, enc.encode(crashed ? 'crash\n' : 'clean\n'))
  const safeMode = opts.safeMode === true
  if (safeMode) await fs.writeFile(SAFE_FILE, enc.encode('1\n'))
  else await fs.unlink(SAFE_FILE).catch(() => {})
  await fs.flush() // the marker must survive a crash right after boot
  await users.load(fs)

  progress('settings', 0.25) // nothing to do: the kernel loaded the settings already

  // 3. Core utilities.
  progress('userland', 0.4)
  if (opts.userland !== false) {
    const programs = await fetchJson(opts.userland ?? new URL('userland.json', import.meta.url), warnings, 'userland')
    for (const [name, source] of Object.entries(programs ?? {})) await install(fs, `/bin/${name}`, source, 0o755)
  }

  // 4. System services as bundles, then the apps found on disk.
  progress('services', 0.55)
  if (opts.services !== false) {
    const sources = await fetchJson(opts.services ?? new URL('services.json', import.meta.url), warnings, 'services')
    await bundles.scan()
    for (const svc of SERVICES) {
      const source = sources?.[svc.file]
      if (source === undefined) continue
      const files = {
        'manifest.json': JSON.stringify({ id: svc.id, name: svc.name, version: OS_VERSION, entry: 'main.js', kind: 'service', autostart: true }),
        'main.js': source,
      }
      const installed = bundles.find(svc.id)
      if (!installed) await bundles.install({ files }, { location: SYSTEM_APPS })
      else if (dec.decode(await fs.readFile(installed.entryPath)) !== source) await bundles.update(svc.id, { files })
    }
  }
  await bundles.scan()

  // 5. Start the services and wait until each has registered its port.
  progress('starting', 0.75)
  const up: string[] = []
  for (const b of bundles.list()) {
    if (b.kind !== 'service' || !b.autostart) continue
    if (safeMode && !b.system) continue // third-party services wait for a normal boot
    const info = bundles.find(b.id)!
    if (procs.pidsOf(b.id).length) continue
    await launch.spawn(info, [])
    const known = SERVICES.find((s) => s.id === b.id)
    if (!known) continue
    for (let waited = 0; procs.ports.find(known.port) === undefined && waited <= 5000; waited += 10) await new Promise((r) => setTimeout(r, 10))
    if (procs.ports.find(known.port) !== undefined) up.push(known.port)
    else warnings.push(`${known.name} did not register ${known.port}`)
  }

  progress('ready', 1)
  logger?.write({ level: 'notice', subsystem: 'boot', message: `Pear ${OS_VERSION} booted${firstBoot ? ' (first run)' : ''}${crashed ? ', after an unclean shutdown' : ''}`, data: { services: up, warnings } })
  return { firstBoot, bootTime, version: OS_VERSION, previousShutdown: crashed ? 'crash' : 'clean', safeMode, services: up, warnings }
}
