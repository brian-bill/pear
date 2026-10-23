/// Users and groups. The tables live in `/etc/passwd` and `/etc/group` (written at first boot); until then
/// the built-in defaults apply, so the kernel works on a bare file system too.
import type { FileSystem } from './fs'

export interface User {
  name: string
  uid: number
  gid: number
  home: string
}

export interface Group {
  name: string
  gid: number
  members: string[]
}

export interface Credentials {
  uid: number
  gid: number
  /** Supplementary groups. */
  groups: number[]
}

export const ROOT_UID = 0
const WHEEL_GID = 0
const USER_UID = 501
const STAFF_GID = 20

export const DEFAULT_USERS: User[] = [
  { name: 'root', uid: ROOT_UID, gid: WHEEL_GID, home: '/var/root' },
  { name: 'pear', uid: USER_UID, gid: STAFF_GID, home: '/Users/pear' },
]
export const DEFAULT_GROUPS: Group[] = [
  { name: 'wheel', gid: WHEEL_GID, members: ['root'] },
  { name: 'staff', gid: STAFF_GID, members: ['pear'] },
]

export const passwdText = (users: User[]) => users.map((u) => `${u.name}:x:${u.uid}:${u.gid}:${u.home}`).join('\n') + '\n'
export const groupText = (groups: Group[]) => groups.map((g) => `${g.name}:x:${g.gid}:${g.members.join(',')}`).join('\n') + '\n'

export class UserDb {
  users: User[] = DEFAULT_USERS
  groups: Group[] = DEFAULT_GROUPS

  /** Re-read the tables. Missing or damaged files leave the defaults in place. */
  async load(fs: FileSystem): Promise<void> {
    const dec = new TextDecoder()
    const lines = async (path: string) => {
      try {
        return dec.decode(await fs.readFile(path)).split('\n').filter((l) => l.trim() && !l.startsWith('#'))
      } catch {
        return null
      }
    }
    const passwd = await lines('/etc/passwd')
    if (passwd) {
      const users = passwd.flatMap((l) => {
        const [name, , uid, gid, home] = l.split(':')
        return name && Number.isInteger(+uid!) && Number.isInteger(+gid!) ? [{ name, uid: +uid!, gid: +gid!, home: home ?? '/' }] : []
      })
      if (users.length) this.users = users
    }
    const group = await lines('/etc/group')
    if (group) {
      const groups = group.flatMap((l) => {
        const [name, , gid, members] = l.split(':')
        return name && Number.isInteger(+gid!) ? [{ name, gid: +gid!, members: (members ?? '').split(',').filter(Boolean) }] : []
      })
      if (groups.length) this.groups = groups
    }
  }

  byName = (name: string) => this.users.find((u) => u.name === name)
  byUid = (uid: number) => this.users.find((u) => u.uid === uid)

  /** Credentials of a user: primary group plus every group that lists them. */
  credentials(user: User): Credentials {
    const groups = this.groups.filter((g) => g.members.includes(user.name)).map((g) => g.gid)
    return { uid: user.uid, gid: user.gid, groups: [...new Set([user.gid, ...groups])] }
  }

  /** The person using the machine: the first non-root user. */
  get primary(): User {
    return this.users.find((u) => u.uid !== ROOT_UID) ?? this.users[0]!
  }
}

export const ROOT_CREDS: Credentials = { uid: ROOT_UID, gid: WHEEL_GID, groups: [WHEEL_GID] }
