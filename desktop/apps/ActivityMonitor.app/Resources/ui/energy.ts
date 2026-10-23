import { tiny } from '@tiny/sdk'
import type { Sample, Tab } from './types'
import { el, errText, esc } from './util'

interface Assertion { id: number; type: string; reason: string; owner: number; since: number }
interface PowerState { visible: boolean; assertions: number; preventsSleep: boolean; preventsIdle: boolean }

export function energyTab(): Tab {
  const root = el('div', 'panel')
  const pad = el('div', 'pad')
  root.append(pad)
  return {
    id: 'energy',
    title: 'Energy',
    el: root,
    async update(s: Sample) {
      try {
        const [list, state] = await Promise.all([
          tiny.admin.service<Assertion[]>('tiny.timers', { op: 'power.assertions' }),
          tiny.admin.service<PowerState>('tiny.timers', { op: 'power.state' }).catch(() => null),
        ])
        const holder = (pid: number) => {
          const p = s.procs.find((x) => x.pid === pid)
          return p ? `${p.appId ? (s.appNames.get(p.appId) ?? p.appId) : p.name} (pid ${pid})` : `pid ${pid}`
        }
        const owners = new Map<string, number>()
        for (const a of list) owners.set(holder(a.owner), (owners.get(holder(a.owner)) ?? 0) + 1)
        pad.innerHTML = `
          <h3>Power assertions</h3>
          <div class="card row"><span id="summary">${list.length} active</span><span class="grow"></span>
            <span class="dim">${state ? `${state.preventsSleep ? 'Sleep prevented' : 'Sleep allowed'}, ${state.preventsIdle ? 'screen kept on' : 'screen may dim'}` : ''}</span></div>
          ${list.length ? `<table class="plain-table" style="margin-top:8px" aria-label="Power assertions"><thead><tr><th>ID</th><th>Type</th><th>Reason</th><th>Held by</th><th>For</th></tr></thead><tbody>${list
            .map((a) => `<tr><td>${a.id}</td><td>${esc(a.type)}</td><td>${esc(a.reason)}</td><td>${esc(holder(a.owner))}</td><td>${Math.max(0, Math.round((s.now - a.since) / 1000))}s</td></tr>`)
            .join('')}</tbody></table>` : '<div class="empty">Nothing is keeping the system awake.</div>'}
          <h3>Apps holding wake locks</h3>
          ${owners.size ? `<ul style="margin:0;padding-left:18px">${[...owners].map(([n, c]) => `<li>${esc(n)}: ${c}</li>`).join('')}</ul>` : '<div class="dim">None</div>'}`
      } catch (e) {
        pad.innerHTML = `<div class="empty">Energy information is not available: ${esc(errText(e))}</div>`
      }
    },
  }
}
