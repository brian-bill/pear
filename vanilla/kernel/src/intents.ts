/// Install intents in a Pear page's address (`contracts/app-distribution.md`, `contracts/app-registry.md`):
///
///   https://<pear-host>/?install=<encoded source URL>      install an app from a .pearapp or a served directory
///   https://<pear-host>/?addSource=<encoded registry URL>  offer to add an app source
///
/// They are only read here, at boot, and handed to Desktop as typed values. Nothing runs from a link: Desktop shows a
/// prompt (manifest, permissions, `verify`) first, and only after the session has been restored.
import { checkUrl } from './sources'

export type Intent =
  | { kind: 'installUrl'; source: string; receivedAt: string }
  | { kind: 'addSource'; url: string; receivedAt: string }
  /** A link that asked for something this system refuses (plain http, a user name in the URL, ...). Shown, never acted on. */
  | { kind: 'rejected'; param: 'install' | 'addSource'; value: string; reason: string; receivedAt: string }

export const INTENT_PARAMS = ['install', 'addSource'] as const
const MAX_LENGTH = 2048

export function parseIntents(search: string, now: Date = new Date()): Intent[] {
  const receivedAt = now.toISOString()
  const params = new URLSearchParams(search)
  const out: Intent[] = []
  for (const param of INTENT_PARAMS) {
    const value = params.get(param) // one parameter each; a repeat is ignored
    if (value === null) continue
    try {
      if (!value.trim() || value.length > MAX_LENGTH) throw new Error(value.trim() ? 'the link is too long' : 'the link is empty')
      const url = checkUrl(new URL(value.trim()), 'the link').href
      out.push(param === 'install' ? { kind: 'installUrl', source: url, receivedAt } : { kind: 'addSource', url, receivedAt })
    } catch (e) {
      out.push({ kind: 'rejected', param, value: value.slice(0, 200), reason: (e as Error).message || 'not a valid address', receivedAt })
    }
  }
  return out
}

/** The address without the intent parameters, so reloading the page does not ask again. */
export function withoutIntents(href: string): string {
  const url = new URL(href)
  for (const p of INTENT_PARAMS) url.searchParams.delete(p)
  return `${url.pathname}${url.search}${url.hash}`
}
